import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { parse as parseYaml } from "yaml"

import { manifests } from "../ci/check-pins.mjs"
import { logFile, logged } from "./log.mjs"
import { uiBundledImports } from "./ui-bundled-imports.mjs"

// The project-level checks: typecheck (one for each project of
// scripts/ci/projects.json), lint (oxlint, oxfmt, knip), the policy
// scripts of the CI lint job, the tests of the CI scripts, the builds (each
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

// The directories of the ops packages of the workspace (cost-telemetry).
const opsPackages = () =>
  parseYaml(
    readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
  ).packages.filter((directory) => directory.startsWith("ops/"))

// The Dockerfiles and the .dockerignore of the deploy and preview images:
// the tests ci-deploy-images and ci-preview-images check them against their
// inputs (scripts/ci/deploy-images.mjs).
const imageBuildFiles = [
  ".dockerignore",
  "apps/backend/Dockerfile",
  "apps/backend/Dockerfile.worker",
  "apps/ui/Dockerfile",
  "apps/codesearch/Dockerfile",
]

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
      // `bun check` is the checker, so a result key holds the Bun version.
      programs: ["bun"],
      prerequisites: [
        "bun",
        ...({
          "aws-cdk": ["aws-cdk-image-tag"],
          "self-host": ["aws-cdk-build"],
          docs: ["docs-mdx"],
        }[name] ?? []),
      ],
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
    ["ci-jobs", [".github/workflows/**", "scripts/**"]],
    ["ui-motion", ["apps/ui/src/**"]],
    ["story-play-timing", ["apps/ui/src/**"]],
    [
      "page-stories",
      [
        "apps/ui/src/**",
        "apps/ui/.storybook/check-modules.mjs",
        "packages/visual-review/src/story-tags.ts",
        "scripts/ci/page-story-exemptions.json",
      ],
      "Catches a route with no page story and no exemption, or a page story that names a route that does not exist. Run it when a route or a story under apps/ui/src changes; never for a change outside it.",
    ],
    [
      "story-review",
      [
        "apps/ui/src/**",
        "apps/ui/.storybook/check-modules.mjs",
        "packages/visual-review/src/story-tags.ts",
      ],
      "Catches a story with no review kind (page or component) or no purpose sentence for the visual critic. Run it when a story under apps/ui/src changes; never for a change outside it.",
    ],
    [
      "story-format",
      [
        "apps/ui/src/**",
        "apps/ui/.storybook/check-modules.mjs",
        "packages/visual-review/src/story-tags.ts",
      ],
      "Catches a CSF 3 story file and a story file that sets parameters.msw. Run it when a story under apps/ui/src changes; never for a change outside it.",
    ],
    [
      "component-descriptions",
      ["apps/ui/src/**", "scripts/ci/component-descriptions-allowlist.json"],
      "Catches an exported React component under apps/ui/src with no JSDoc description that the allowlist does not have, and an allowlist entry that is no longer necessary. Run it when a .tsx file under apps/ui/src or the allowlist changes; never for a change outside them.",
    ],
    [
      "product-components",
      // knip reads the knip.json entries and the apps/ui sources; the script
      // runs the knip of the lockfile.
      ["knip.json", "apps/ui/**"],
      "Catches a React component under apps/ui/src that only a story or a test renders, so that no product page shows it. Run it when a file under apps/ui or knip.json changes; never for a change outside them.",
    ],
    [
      "storybook-globals",
      ["apps/ui/.storybook/**"],
      "Catches a mock or a wrapper above the story file: MSW handlers in the Storybook preview, or a global decorator that is not an opt-in. Run it when a file under apps/ui/.storybook changes; never for a change outside it.",
    ],
    [
      "duplicate-screenshots",
      [
        "apps/ui/src/**",
        "apps/ui/.storybook/check-modules.mjs",
        "scripts/checks/visual.mjs",
      ],
      "Catches two stories whose committed screenshots have the same pixels, so one UI state has two stories. Run it when a story or a baseline under apps/ui/src changes; never for a change outside it.",
    ],
    [
      "claude-plugin",
      ["plugins/**", ".claude-plugin/**", "scripts/ci/claude-cli/**"],
    ],
    [
      "adr",
      [".ai/memory/decisions/**"],
      "Catches an ADR file that the decisions index does not list. Run it when a file under .ai/memory/decisions changes; never for a change outside it.",
    ],
    [
      "module-scope-values",
      // .gitignore decides which untracked files the check reads.
      ["apps/**", "packages/**", "scripts/**", ".gitignore"],
      "Catches a new module-scope string or number constant that the file reads once, which AGENTS.md says to inline. Run it when app, package, or script source changes; never for a change only to tests or docs.",
    ],
    ["visual-container", ["scripts/ci/visual-container.json"]],
    [
      "docs-links",
      ["apps/**", "packages/**", "plugins/**", "examples/**", "README.md"],
    ],
    [
      "pins",
      // The package.json files that the check reads, found by its own
      // walk (so the listing runs check-pins.mjs: gate.mjs), and the
      // allowlist.
      [
        ...manifests(root).map((file) => relative(root, file)),
        "scripts/ci/pins.json",
      ],
      "Catches an exact version in a package.json dependency field that scripts/ci/pins.json does not name, and an allowlist entry whose file has no exact version of its package. Run it when a package.json or the allowlist changes; never for a change outside them.",
    ],
  ].map(([lane, reads, intent]) => {
    const file = `scripts/ci/check-${lane}.mjs`
    return {
      family: "policy",
      lane,
      file,
      root: "",
      inputs: [...shared, file, ...reads],
      ...(intent && { intent }),
      commands: [node(file)],
    }
  }),
  // The tests of the CI scripts: one check for each file of scripts/tests,
  // so that a change selects only the tests that read it. Each test reads
  // the scripts, the workflows and the files outside scripts/ that the
  // scripts import; the map adds the other files that a test reads.
  ...readdirSync(join(root, "scripts/tests"))
    .filter((name) => /\.test\.(mjs|sh)$/.test(name))
    .map((name) => {
      const file = `scripts/tests/${name}`
      const stem = name.replace(/\.test\.(mjs|sh)$/, "")
      return {
        family: "policy",
        lane: `tests-${stem}`,
        file,
        root: "scripts/tests",
        inputs: [
          ...shared,
          "scripts/**",
          ".github/**",
          "apps/ui/.storybook/**",
          "apps/backend/evals/mcp/**",
          "packages/visual-review/src/**",
          ...({
            // The manifest of the whole repo, or the files of the apps.
            // The ops test reads the package file and the tsconfig.json of
            // each ops package.
            "ci-checks-repo": [
              ...code,
              ...opsPackages().flatMap((directory) =>
                ["package.json", "tsconfig.json"]
                  .map((name) => `${directory}/${name}`)
                  .filter((file) => existsSync(join(root, file))),
              ),
            ],
            // The edge hooks resolve the backend packages from this manifest;
            // the lockfile holds their versions.
            "ci-checks": ["apps/backend/package.json"],
            "ci-merge-gate": code,
            "ci-merge-gate-plan": code,
            "ci-test-policy": code,
            "ci-service-pins": [...code, "docker-compose.yml"],
            // Every tracked file against the inputs of the critics.
            "ci-critics": [
              ...code,
              ".agents/**",
              "AGENTS.md",
              ".ai/memory/lessons-learned.md",
            ],
            "ci-codesearch-releases": ["apps/codesearch/scripts/**"],
            "ci-codesearch-selection": ["apps/codesearch/**"],
            "ci-deploy-images": [
              ...imageBuildFiles,
              "ops/observability/cost-telemetry/Dockerfile",
            ],
            "ci-preview-images": imageBuildFiles,
            "ci-test-shards": ["apps/backend/**"],
            "ci-visual-container": ["apps/ui/package.json"],
          }[stem] ?? []),
        ],
        commands: [
          name.endsWith(".sh") ? ["bash", file] : node("--test", file),
        ],
      }
    }),
  // The tests of each ops package of the workspace that has a `test` script
  // (cost-telemetry): one check for each package. Its typecheck is a project
  // of scripts/ci/projects.json. The tests run with Bun, so a result key holds
  // the Bun version. The lane does not start with `tests-`: the merge gate
  // takes each `policy:tests-*` check as a test of the CI scripts (plan.mjs).
  ...opsPackages().flatMap((directory) => {
    const { name, scripts = {} } = JSON.parse(
      readFileSync(join(root, directory, "package.json"), "utf8"),
    )
    if (!scripts.test) return []
    return [
      {
        family: "policy",
        lane: `package-tests-${name}`,
        file: `${directory}/package.json`,
        root: directory,
        inputs: [...shared, `${directory}/**`],
        runtime: "bun",
        prerequisites: ["bun"],
        intent: `Catches a failed test of the ${name} package. Run it when a file of the package or the lockfile changes; never for a change outside them.`,
        commands: [pnpm("--filter", name, "test")],
      },
    ]
  }),
  // The production images of the Production build job: one check for each
  // image. A build pulls base images by tag and packages from the network
  // without a lock, so the same inputs can give another result: a result
  // cache never reuses it, but the selector selects it by its inputs. The release and deploy images come only from the
  // deploy workflows, never from this check.
  ...[
    // The layer cache of the Rust converter stage (Kingfisher and vectorscan,
    // ADR-072), as for codesearch below.
    [
      "backend",
      "apps/backend/Dockerfile",
      ["apps/backend/**", "shared/**"],
      [
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-backend",
      ],
    ],
    [
      "worker",
      "apps/backend/Dockerfile.worker",
      ["apps/backend/**", "shared/**"],
      [
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-worker",
      ],
    ],
    [
      "ui",
      "apps/ui/Dockerfile",
      [
        "apps/ui/**",
        ...uiBundledImports(),
        "apps/backend/package.json",
        "scripts/checks/ui-bundled-imports.mjs",
      ],
      // The layer caches of main (the Layer cache job of ci.yaml).
      [
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-ui",
      ],
    ],
    [
      "codesearch",
      "apps/codesearch/Dockerfile",
      ["apps/codesearch/**", "shared/**"],
      // The layer cache of the codesearch toolchain stages (linux/arm64):
      // the Layer cache job of ci.yaml writes it on main; a reader needs no
      // login.
      [
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-codesearch",
      ],
    ],
    [
      "docs",
      "apps/docs/Dockerfile",
      ["apps/docs/**"],
      [
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-docs",
      ],
    ],
    [
      "chat-sandbox",
      "scripts/chat-sandbox/Dockerfile",
      ["scripts/chat-sandbox/**"],
      [],
      "scripts/chat-sandbox",
    ],
    // The hourly cost job of ops/observability (deploy.yaml publishes it).
    [
      "cost-telemetry",
      "ops/observability/cost-telemetry/Dockerfile",
      ["ops/observability/cost-telemetry/**"],
      [
        "--cache-from",
        "type=registry,ref=ghcr.io/ctxpipe-ai/ci-cache:production-cost-telemetry",
      ],
      "ops/observability/cost-telemetry",
    ],
  ].map(([name, file, reads, flags = [], context = "."]) => {
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
      uncached:
        "a build pulls base images by tag, and packages from the network without a lock",
      prerequisites: ["docker"],
      intent: `Catches a ${name} production image that does not build. Run it when its Dockerfile, the lockfile or the source that it copies changes; never for a change only to tests or docs of another app.`,
      // `type=cacheonly`: the check only proves that the image builds. The
      // builder of `factory check` loads each image it exports into the
      // Docker store of the host, and an image of a build without a tag stays
      // there with no name (CTX-1551).
      commands: [
        [
          "docker",
          "buildx",
          "build",
          "--progress=plain",
          "--output=type=cacheonly",
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
]

export function listProjects() {
  // An image build depends on the platform that builds the image;
  // the result of each other check does not depend on the OS or the CPU.
  // A shell test runs fixed fixtures through POSIX options of the host tools
  // (bash, grep, sed, jq, python3) only, so it gives the same result on macOS
  // and Linux.
  const portable = ({ family, lane }) =>
    ["typecheck", "lint", "policy"].includes(family) ||
    (family === "build" && lane.startsWith("package-"))
  // A check has no cache only with its reason (`uncached`): a definition
  // cannot set `cacheable` itself.
  return definitions().map(
    ({
      commands: _commands,
      cacheable: _cacheable,
      uncached,
      prerequisites,
      runtime,
      ...check
    }) => ({
      id: `${check.family}:${check.lane}:${check.file}`,
      ...check,
      ...(uncached && { cacheable: false }),
      runtime: runtime ?? "node",
      ...(prerequisites && { prerequisites }),
      ...(portable(check) && { portable: true }),
    }),
  )
}

// The commands of each project check, by id.
export const projectCommands = () =>
  new Map(
    definitions().map((check) => [
      `${check.family}:${check.lane}:${check.file}`,
      check.commands,
    ]),
  )

// Runs each check's commands in order; the check fails at the first command
// that fails.
export function runProjects(checks) {
  const commands = projectCommands()
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
