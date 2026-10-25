import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

export const root = fileURLToPath(new URL("../../", import.meta.url))

// Each lane is one Vitest run: one package directory, one config, one runtime.
// The CI scripts own which test files belong to a lane; this module only reads
// their inventories. Paths are repo-relative.
const shared = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
const backendInputs = [
  ...shared,
  "tsconfig.json",
  "apps/backend/package.json",
  "apps/backend/tsconfig.json",
  "apps/backend/vitest.config.ts",
  "apps/backend/src/test/setup-evlog.ts",
  "apps/backend/src/test/setup-openworkflow-runs.ts",
  "apps/backend/migrations/**",
  "scripts/ci/contracts.json",
]
const codesearchInputs = [
  ...shared,
  "tsconfig.json",
  "apps/codesearch/package.json",
  "apps/codesearch/tsconfig.json",
  "apps/codesearch/vitest.config.ts",
  "apps/codesearch/src/test/setup-evlog.ts",
  "apps/codesearch/scripts/run-vitest-contracts.mjs",
]
// `traceInputs` names the inputs for which a reader with a trace may select
// from the trace instead of the whole lane (manifest.v1.schema.json).
// The migrations are Drizzle migration directories: `migration.sql`, which
// the tests apply, and `snapshot.json`, which only drizzle-kit reads.
const backendTraceInputs = { "apps/backend/migrations/**": "tables" }
export const lanes = {
  backend: {
    directory: "apps/backend",
    runtime: "node",
    inputs: backendInputs,
    traceInputs: backendTraceInputs,
  },
  contracts: {
    directory: "apps/backend",
    runtime: "node",
    inputs: backendInputs,
    traceInputs: backendTraceInputs,
  },
  vercel: {
    directory: "apps/backend",
    runtime: "node",
    inputs: backendInputs,
    traceInputs: backendTraceInputs,
  },
  ui: {
    directory: "apps/ui",
    runtime: "node",
    inputs: [
      ...shared,
      "apps/ui/package.json",
      "apps/ui/tsconfig.json",
      "apps/ui/vite.config.ts",
    ],
  },
  cli: {
    directory: "packages/cli",
    runtime: "node",
    inputs: [
      ...shared,
      "tsconfig.json",
      "packages/cli/package.json",
      "packages/cli/tsconfig.json",
      "packages/cli/tsconfig.build.json",
      // Tests run the built bin/ctxpipe.js, so imports do not show this source.
      "packages/cli/src/**",
      "packages/cli/bin/**",
    ],
    // The trace records the lines of the child processes that run the CLI.
    traceInputs: {
      "packages/cli/src/**": "lines",
      "packages/cli/bin/**": "lines",
    },
  },
  "aws-cdk": {
    directory: "packages/aws-cdk",
    runtime: "node",
    inputs: [
      ...shared,
      "packages/aws-cdk/package.json",
      "packages/aws-cdk/tsconfig.json",
      "packages/aws-cdk/scripts/stamp-image-tag.mjs",
    ],
  },
  // CI runs codesearch in its Docker test image (zoekt and the SCIP indexers).
  codesearch: {
    directory: "apps/codesearch",
    runtime: "node",
    inputs: codesearchInputs,
  },
  "codesearch-bun": {
    directory: "apps/codesearch",
    runtime: "bun",
    inputs: codesearchInputs,
  },
}

const json = async (script, args) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [script, ...args],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  )
  return JSON.parse(stdout)
}

export async function listChecks() {
  const suites = ["backend", "contracts", "vercel", "ui", "cli", "aws-cdk"]
  const [codesearch, ...inventories] = await Promise.all([
    json("apps/codesearch/scripts/run-vitest-contracts.mjs", ["--list"]),
    ...suites.map((lane) =>
      json("scripts/ci/test-suite.mjs", [lane, "--list"]),
    ),
  ])
  const files = Object.fromEntries(
    suites.map((lane, index) => [lane, inventories[index]]),
  )
  files.codesearch = codesearch.node
  files["codesearch-bun"] = codesearch.bun
  const checks = Object.entries(files).flatMap(([lane, list]) =>
    list.map((relative) => {
      const file = `${lanes[lane].directory}/${relative}`
      // A check id is `<family>:<lane>:<file>`. A later version adds case ids
      // as `<family>:<lane>:<file>#<case>`, so a file id stays a prefix.
      return {
        id: `vitest:${lane}:${file}`,
        family: "vitest",
        lane,
        root: lanes[lane].directory,
        file,
        inputs: lanes[lane].inputs,
        ...(lanes[lane].traceInputs
          ? { traceInputs: lanes[lane].traceInputs }
          : {}),
      }
    }),
  )
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { schemaVersion: 1, checks }
}
