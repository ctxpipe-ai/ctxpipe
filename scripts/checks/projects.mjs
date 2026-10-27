import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { logFile, logged } from "./log.mjs"

// The project-level checks: typecheck (one for each project of
// scripts/ci/projects.json), lint (oxlint, oxfmt, knip), the policy
// scripts (of the CI lint job, and the Terraform plan) and the builds (each
// production image and each package of the CI build jobs). Each one runs a
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
    // same inputs can give another result.
    family: "policy",
    lane: "terraform-plan",
    file: "infra/main.tf",
    root: "infra",
    inputs: [...shared, "infra/**"],
    stochastic: true,
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
  // cache never reuses it. The release and deploy images come only from the
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
      // The layer cache of the codesearch toolchain stages. The Layer cache
      // job of ci.yaml writes it on main; a reader needs no login.
      [
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
      stochastic: true,
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
  // result is a function of its inputs.
  ...[
    ["backend", "@ctxpipe/backend", "apps/backend", ["shared/**"], ["bun"]],
    [
      "codesearch",
      "@ctxpipe/codesearch",
      "apps/codesearch",
      ["shared/**"],
      ["bun"],
    ],
    ["aws-cdk", "@ctxpipe/aws-cdk", "packages/aws-cdk", ["tsconfig.json"]],
    ["cli", "ctxpipe", "packages/cli", ["tsconfig.json"]],
  ].map(([name, pkg, directory, reads, prerequisites]) => ({
    family: "build",
    lane: `package-${name}`,
    file: `${directory}/package.json`,
    root: directory,
    inputs: [...shared, `${directory}/**`, ...reads],
    prerequisites,
    intent: `Catches a ${pkg} build that fails. Run it when the package source, its build config or the lockfile changes; never for a change outside the files that it reads.`,
    commands: [pnpm("--filter", pkg, "build")],
  })),
]

export function listProjects() {
  return definitions().map(
    ({ commands: _commands, prerequisites, ...check }) => ({
      id: `${check.family}:${check.lane}:${check.file}`,
      ...check,
      runtime: "node",
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
