import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

export const root = fileURLToPath(new URL("../../", import.meta.url))
const schemaVersion = 1

// Each lane is one Vitest run: one package directory, one config, one runtime.
// The CI scripts own which test files belong to a lane; this module only reads
// their inventories. Paths are repo-relative.
const shared = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
// Backend and contract lanes run scripts/ci/prerequisites.mjs in CI.
const native = [
  "node",
  "git",
  "ast-grep",
  "bun",
  "opencode",
  "zoekt",
  "postgres",
  "migrations",
  "falkordb",
]
const backendInputs = [
  ...shared,
  "tsconfig.json",
  "apps/backend/package.json",
  "apps/backend/tsconfig.json",
  "apps/backend/vitest.config.ts",
  "apps/backend/src/test/setup-evlog.ts",
  "apps/backend/src/test/setup-openworkflow-runs.ts",
  "scripts/ci/contracts.json",
]
const codesearchInputs = [
  ...shared,
  "tsconfig.json",
  "apps/codesearch/package.json",
  "apps/codesearch/tsconfig.json",
  "apps/codesearch/scripts/run-vitest-contracts.mjs",
]
export const lanes = {
  backend: {
    directory: "apps/backend",
    runtime: "node",
    prerequisites: native,
    inputs: backendInputs,
  },
  contracts: {
    directory: "apps/backend",
    runtime: "node",
    prerequisites: [...native, "docker", "sandbox-image"],
    inputs: backendInputs,
  },
  vercel: {
    directory: "apps/backend",
    runtime: "node",
    prerequisites: ["node", "vercel-token"],
    inputs: backendInputs,
  },
  ui: {
    directory: "apps/ui",
    runtime: "node",
    prerequisites: ["node"],
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
    // The runner compiles the CLI before its tests, as test-suite.mjs does.
    prerequisites: ["node"],
    inputs: [
      ...shared,
      "tsconfig.json",
      "packages/cli/package.json",
      "packages/cli/tsconfig.json",
      "packages/cli/tsconfig.build.json",
    ],
  },
  "aws-cdk": {
    directory: "packages/aws-cdk",
    runtime: "node",
    prerequisites: ["node"],
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
    prerequisites: ["node", "git", "zoekt", "scip-indexers"],
    inputs: codesearchInputs,
  },
  "codesearch-bun": {
    directory: "apps/codesearch",
    runtime: "bun",
    prerequisites: ["bun", "git", "zoekt", "scip-indexers"],
    inputs: codesearchInputs,
  },
}

// A check id is `<family>:<lane>:<file>`. A later version adds case ids as
// `<family>:<lane>:<file>#<case>`, so a file id stays a prefix of its cases.
const checkId = (lane, file) => `vitest:${lane}:${file}`

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
      return {
        id: checkId(lane, file),
        family: "vitest",
        lane,
        file,
        prerequisites: lanes[lane].prerequisites,
        inputs: lanes[lane].inputs,
      }
    }),
  )
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { schemaVersion, checks }
}
