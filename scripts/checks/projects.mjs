import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { logFile, logged } from "./log.mjs"

// The project-level checks: typecheck (one for each project of
// scripts/ci/projects.json), lint (oxlint, oxfmt, knip), the policy
// scripts (of the CI lint job, and the Terraform plan), the builds (each
// production image and each package of the CI build jobs) and the preview
// deployment with its UI smoke test. Each one runs a
// fixed command over a whole project, so it has no trace. Its inputs are the
// files that it reads, approximated with whole directories: a change anywhere
// in them selects it.

const root = fileURLToPath(new URL("../../", import.meta.url))
const shared = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "scripts/checks/projects.mjs",
]
const node = (script, ...args) => [process.execPath, script, ...args]
const pnpm = (...args) => ["pnpm", ...args]

const code = ["apps/**", "packages/**"]

// Each check: lane, file (the config or script that defines it), root,
// inputs and the commands to run.
const definitions = () => [
  ...JSON.parse(
    readFileSync(join(root, "scripts/ci/projects.json"), "utf8"),
  ).map(({ name, project }) => {
    const directory = project.replace(/\/tsconfig\.json$/, "")
    const diagnostics = `scripts/ci/diagnostics/${name}.json`
    return {
      family: "typecheck",
      lane: name,
      file: project,
      root: directory,
      inputs: [
        ...shared,
        "tsconfig.json",
        `${directory}/**`,
        ...({
          // The directories that a typecheck reads, other than its own.
          // The backend and codesearch import the repo-root shared/ directory.
          // Backend contract tests import the codesearch source and a CI script.
          backend: [
            "shared/**",
            "apps/codesearch/src/**",
            "scripts/ci/graph-ready.mjs",
          ],
          codesearch: ["shared/**"],
          // apps/ui/tsconfig.json maps paths into the backend source (the RPC
          // types), and that source imports shared/.
          ui: ["apps/backend/src/**", "shared/**"],
          "self-host": ["packages/aws-cdk/**"],
        }[name] ?? []),
        diagnostics,
        "scripts/ci/projects.json",
        "scripts/ci/typecheck.mjs",
        "scripts/ci/check-allowlist-history.mjs",
      ],
      prerequisites: {
        "aws-cdk": ["aws-cdk-image-tag"],
        "self-host": ["aws-cdk-build"],
        docs: ["docs-mdx"],
      }[name],
      commands: [
        node("scripts/ci/check-allowlist-history.mjs", diagnostics),
        node("scripts/ci/typecheck.mjs", project, diagnostics),
      ],
    }
  }),
  {
    family: "lint",
    lane: "oxlint",
    file: ".oxlintrc.json",
    root: "",
    inputs: [...shared, ".oxlintrc.json", ...code],
    commands: [pnpm("lint")],
  },
  {
    family: "lint",
    lane: "format",
    file: ".oxfmtrc.json",
    root: "",
    inputs: [...shared, ".oxfmtrc.json", ...code],
    commands: [pnpm("format:check")],
  },
  {
    family: "lint",
    lane: "knip",
    file: "knip.json",
    root: "",
    inputs: [
      ...shared,
      "knip.json",
      ...code,
      "examples/**",
      "scripts/**",
      ".github/**",
    ],
    commands: [pnpm("knip")],
  },
  {
    // The plan of terraform-plan-pr.yaml. It reads the remote state, so the
    // same inputs can give another result: a result cache never reuses it.
    family: "policy",
    lane: "terraform-plan",
    file: "infra/main.tf",
    root: "infra",
    inputs: [...shared, "infra/**"],
    cacheable: false,
    prerequisites: ["terraform-plan"],
    intent:
      "Catches a Terraform change that the plan rejects or that changes infrastructure. Run it when a file under infra changes; never for app code.",
    commands: [
      [
        "sh",
        "-c",
        'terraform -chdir=infra init -input=false -lockfile=readonly -backend-config="access_key=$R2_ACCESS_KEY_ID" -backend-config="secret_key=$R2_SECRET_ACCESS_KEY" -backend-config="key=production/terraform.tfstate"',
      ],
      [
        "env",
        "RAILWAY_TOKEN=pr-plan-placeholder",
        "NEON_API_KEY=pr-plan-placeholder",
        "terraform",
        "-chdir=infra",
        "plan",
        "-refresh=false",
        "-no-color",
        "-input=false",
      ],
    ],
  },
  ...[
    // The test policy compares the tests with a pinned commit; the script
    // fetches it.
    ["test-policy", ["apps/**", "packages/**", "scripts/ci/**"]],
    [
      "agent-harness",
      [
        "AGENTS.md",
        "apps/**",
        "packages/**",
        ".agents/**",
        ".claude/**",
        ".codex/**",
        ".cursor/**",
        ".mcp.json",
        "opencode.json",
      ],
    ],
    ["workflow-credentials", [".github/**"]],
    ["secret-jobs", [".github/**", "scripts/**"]],
    ["runners", [".github/**"]],
    ["workflow-inputs", [".github/**"]],
    ["ui-motion", ["apps/ui/src/**"]],
    ["story-play-timing", ["apps/ui/src/**"]],
    ["claude-plugin", ["plugins/**", ".claude-plugin/**"]],
  ].map(([lane, reads]) => {
    const file = `scripts/ci/check-${lane}.mjs`
    return {
      family: "policy",
      lane,
      file,
      root: "",
      inputs: [...shared, file, ...reads],
      commands: [node(file)],
    }
  }),
  // The production images of the Production build job: one check for each
  // image. A build pulls base images by tag and packages from the network
  // without a lock, so the same inputs can give another result: a result
  // cache never reuses it, but the selector selects it by its inputs. The release and deploy images come only from the
  // deploy workflows, never from this check.
  ...[
    ["backend", "apps/backend/Dockerfile", ["apps/backend/**", "shared/**"]],
    [
      "worker",
      "apps/backend/Dockerfile.worker",
      ["apps/backend/**", "shared/**"],
    ],
    [
      "ui",
      "apps/ui/Dockerfile",
      ["apps/ui/**", "apps/backend/src/**", "apps/backend/package.json"],
    ],
    [
      "codesearch",
      "apps/codesearch/Dockerfile",
      ["apps/codesearch/**", "shared/**"],
      // The Dockerfile builds only for amd64. The layer cache of the
      // codesearch toolchain stages: the Layer cache job of ci.yaml writes it
      // on main; a reader needs no login.
      [
        "--platform",
        "linux/amd64",
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-codesearch",
      ],
    ],
    ["docs", "apps/docs/Dockerfile", ["apps/docs/**"]],
    [
      "chat-sandbox",
      "scripts/chat-sandbox/Dockerfile",
      ["scripts/chat-sandbox/**"],
      // The AWS sandbox host is arm64, and no other job builds it for arm64
      // before a release.
      ["--platform", "linux/arm64"],
    ],
  ].map(([name, file, reads, flags = []]) => {
    const context = name === "chat-sandbox" ? "scripts/chat-sandbox" : "."
    return {
      family: "build",
      lane: `image-${name}`,
      file,
      root: file.replace(/\/[^/]+$/, ""),
      inputs: [
        ...shared,
        file,
        ...(context === "."
          ? [".dockerignore", "tsconfig.json", "patches/**"]
          : []),
        ...reads,
      ],
      cacheable: false,
      prerequisites: ["docker"],
      intent: `Catches a ${name} production image that does not build. Run it when its Dockerfile, the lockfile or the source that it copies changes; never for a change only to tests or docs of another app.`,
      commands: [
        [
          "docker",
          "buildx",
          "build",
          "--progress=plain",
          "--file",
          file,
          ...flags,
          context,
        ],
      ],
    }
  }),
  // The package builds of the Runnable packages job: one check for each
  // package. Each build reads only the checkout and the lockfile, so its
  // result is a function of its inputs. The backend and codesearch builds
  // run Bun. The aws-cdk build stamps an image tag (IMAGE_TAG, else
  // GITHUB_SHA or a git ref); the check sets a fixed tag, so the output
  // does not depend on the commit.
  ...[
    ["backend", "@ctxpipe/backend", "apps/backend", ["shared/**"], "bun"],
    [
      "codesearch",
      "@ctxpipe/codesearch",
      "apps/codesearch",
      ["shared/**"],
      "bun",
    ],
    ["aws-cdk", "@ctxpipe/aws-cdk", "packages/aws-cdk", ["tsconfig.json"]],
    ["cli", "ctxpipe", "packages/cli", ["tsconfig.json"]],
  ].map(([name, pkg, directory, reads, runtime]) => ({
    family: "build",
    lane: `package-${name}`,
    file: `${directory}/package.json`,
    root: directory,
    inputs: [...shared, `${directory}/**`, ...reads],
    ...(runtime && { runtime, prerequisites: [runtime] }),
    intent: `Catches a ${pkg} build that fails. Run it when the package source, its build config or the lockfile changes; never for a change outside the files that it reads.`,
    commands: [
      name === "aws-cdk"
        ? ["env", "IMAGE_TAG=check", ...pnpm("--filter", pkg, "build")]
        : pnpm("--filter", pkg, "build"),
    ],
  })),
  // The preview deployment of pr-deploy.yaml, and the check that runs against
  // the deployed preview. Each result comes from Railway and Neon, so a result
  // cache never reuses it. The secrets are in the GitHub environment Preview,
  // so the check runs the workflow on the PR branch (PR_NUMBER) and waits.
  {
    family: "deploy",
    lane: "preview",
    file: ".github/workflows/pr-deploy.yaml",
    root: "",
    inputs: [
      ...shared,
      ".github/workflows/pr-deploy.yaml",
      // The scripts that the workflow sources: Railway, Neon, the service
      // variables and the secret names that the deploy sets.
      "scripts/railway-graphql.sh",
      "scripts/preview-app-db-password.sh",
      "scripts/preview-github-app-vars.sh",
      "scripts/preview-neon-branch.sh",
      "scripts/preview-otel-vars.sh",
      "scripts/preview-own-secrets.sh",
      "scripts/preview-sandbox-vars.sh",
      "scripts/preview-secrets.sh",
      "scripts/preview-service-vars.sh",
      "scripts/preview-ui-private.sh",
      // The images, their start commands and the variables that they read.
      // No app source file other than env.ts: a selector follows the imports
      // of a source input, so an entry file would select on all app code.
      "apps/backend/Dockerfile",
      "apps/backend/Dockerfile.worker",
      "apps/ui/Dockerfile",
      "apps/codesearch/Dockerfile",
      "apps/codesearch/start.sh",
      "apps/backend/package.json",
      "apps/backend/src/config/env.ts",
      "apps/backend/migrations/**",
      // The connector asset job, which the deploy needs.
      "apps/backend/vitest.connector-assets.config.ts",
      // The production environment that each preview copies.
      "infra/module/ctxpipe/railway.tf",
      "infra/module/ctxpipe/neon.tf",
    ],
    cacheable: false,
    prerequisites: ["preview-pr"],
    intent:
      "Catches a preview deployment that does not start or wire up: images, start commands, variables, migrations, Railway or Neon setup. Run it when that config changes; never for a change that unit and contract checks already cover.",
    commands: [
      [
        "sh",
        "-c",
        'set -e; branch="$(git branch --show-current)"; gh workflow run pr-deploy.yaml --ref "$branch" -f pr_number="$PR_NUMBER"; sleep 10; gh run watch --exit-status "$(gh run list --workflow pr-deploy.yaml --branch "$branch" --event workflow_dispatch --limit 1 --json databaseId --jq ".[0].databaseId")"',
      ],
    ],
  },
  {
    family: "deploy",
    lane: "preview-ui-smoke",
    file: "scripts/ci/smoke-preview-ui.sh",
    root: "",
    inputs: [
      ...shared,
      "scripts/ci/smoke-preview-ui.sh",
      "scripts/preview-ui-private.sh",
      "apps/ui/Dockerfile",
      "apps/backend/src/routes/ui.ts",
    ],
    cacheable: false,
    prerequisites: ["preview-deployment"],
    intent:
      "Catches a preview whose backend does not serve the UI of its own build (the private UI proxy). Run it when the UI proxy or the UI image changes; never for a change inside UI pages.",
    commands: [
      [
        "sh",
        "-c",
        'bash scripts/ci/smoke-preview-ui.sh "https://backend-pr-$PR_NUMBER.up.railway.app"',
      ],
    ],
  },
]

export function listProjects() {
  return definitions().map(
    ({ commands: _commands, prerequisites, runtime, ...check }) => ({
      id: `${check.family}:${check.lane}:${check.file}`,
      ...check,
      runtime: runtime ?? "node",
      ...(prerequisites && { prerequisites }),
    }),
  )
}

// Runs each check's commands in order; the check fails at the first command
// that fails.
export function runProjects(checks) {
  const commands = new Map(
    definitions().map((check) => [
      `${check.family}:${check.lane}:${check.file}`,
      check.commands,
    ]),
  )
  const records = checks.map(({ id, family, lane }) => {
    const log = logFile(`${family}-${lane}`)
    const started = performance.now()
    let failure
    for (const [command, ...args] of commands.get(id)) {
      const run = logged(log.path, command, args, {
        cwd: root,
        timeout: 1_800_000,
      })
      if (run.error || run.status !== 0) {
        failure = `${command === process.execPath ? "node" : command} ${args.join(" ")} failed (${run.error?.message ?? run.signal ?? `exit ${run.status}`}); see the log`
        break
      }
    }
    const durationMs = Math.round(performance.now() - started)
    const status = failure ? "failed" : "passed"
    return {
      id,
      status,
      durationMs,
      cases: [
        {
          name: lane,
          status,
          durationMs,
          ...(failure && { message: failure }),
        },
      ],
      log: log.relative,
    }
  })
  return { records }
}
