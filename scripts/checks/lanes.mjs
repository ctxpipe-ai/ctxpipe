import { execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { setupSteps, vitestCommand } from "../ci/vitest-launch.mjs"
import { logFile, logged } from "./log.mjs"
import { freshParts, laneChecks as readParts } from "./trace.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

// Each lane is one Vitest run: one package directory, one config, one runtime.
// The CI scripts own which test files belong to a lane; this module only reads
// their inventories. Paths are repo-relative.
// The runner and the launch script set up and start every Vitest run, so a
// change to them can change any result.
const shared = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "scripts/checks/run.mjs",
  "scripts/ci/vitest-launch.mjs",
]
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
// The files that pin the tools and images of the native backend tests:
// the prerequisite check (it compares the OpenCode version with the declared
// one) and the chat sandbox image.
const nativeInputs = [
  "scripts/ci/prerequisites.mjs",
  "scripts/ci/graph-ready.mjs",
  "apps/backend/src/domain/workspaces/workspace-chat-opencode-contract.ts",
  "scripts/chat-sandbox/**",
]
// Environment variables that change backend results. A result cache adds a
// hash of the value of each `value` variable to its key, and only set or unset
// for each `presence` variable. A `value` is the same on every machine. A
// secret, or an address that only points at a service, is `presence`: tests
// set their own address, and an address differs for each checkout. Connection
// strings and secrets that only point at a test service are not here.
const backendEnv = [
  { name: "NODE_ENV", mode: "value" },
  { name: "MODEL_PROVIDER", mode: "value" },
  { name: "AUTH_BASE_URL", mode: "presence" },
  { name: "MODEL_PROVIDER_URL", mode: "presence" },
  { name: "GITHUB_TOKEN", mode: "presence" },
]
const codesearchInputs = [
  ...shared,
  "tsconfig.json",
  "apps/codesearch/package.json",
  "apps/codesearch/tsconfig.json",
  "apps/codesearch/vitest.config.ts",
  "apps/codesearch/src/test/setup-evlog.ts",
  "apps/codesearch/scripts/run-vitest-contracts.mjs",
  // The test image pins zoekt and the SCIP indexers.
  "apps/codesearch/Dockerfile",
]
// `traceInputs` names the inputs for which a reader with a trace may select
// from the trace instead of the whole lane (manifest.v1.schema.json).
// The migrations are Drizzle migration directories: `migration.sql`, which
// the tests apply, and `snapshot.json`, which only drizzle-kit reads.
const backendTraceInputs = { "apps/backend/migrations/**": "tables" }
// The named prerequisites (prerequisites.mjs) that the runner makes or
// verifies before a lane runs. The CI jobs set up the same things.
const databases = ["postgres", "migrations", "falkordb"]
const nativePrerequisites = [
  ...databases,
  "bun",
  "opencode",
  "zoekt",
  "ast-grep",
  "chat-sandbox-image",
]
const lanes = {
  backend: {
    directory: "apps/backend",
    runtime: "node",
    inputs: [...backendInputs, ...nativeInputs],
    traceInputs: backendTraceInputs,
    env: backendEnv,
    prerequisites: nativePrerequisites,
  },
  contracts: {
    directory: "apps/backend",
    runtime: "node",
    inputs: [...backendInputs, ...nativeInputs],
    traceInputs: backendTraceInputs,
    env: backendEnv,
    prerequisites: nativePrerequisites,
  },
  vercel: {
    directory: "apps/backend",
    runtime: "node",
    inputs: backendInputs,
    traceInputs: backendTraceInputs,
    env: [...backendEnv, { name: "VERCEL_TOKEN", mode: "presence" }],
    // The Vercel contracts do not use the graph, and the CI job has no
    // FalkorDB.
    prerequisites: ["postgres", "migrations"],
  },
  // The files that do not end in `.test.ts` have their own Vitest config,
  // so the PR suite never runs them. Wall-clock bounds vary on shared
  // runners, so a latency result is stochastic.
  latency: {
    directory: "apps/backend",
    runtime: "node",
    config: "vitest.latency.config.ts",
    match: /^src\/.*\.latency\.ts$/,
    inputs: [...backendInputs, "apps/backend/vitest.latency.config.ts"],
    traceInputs: backendTraceInputs,
    env: backendEnv,
    prerequisites: databases,
    stochastic: true,
  },
  // The upgrade from the previous release (the CI job
  // upgrade-from-previous-release). It makes its own database, so its
  // DATABASE_URL is a role that can create databases and roles.
  upgrade: {
    directory: "apps/backend",
    runtime: "node",
    config: "vitest.upgrade.config.ts",
    match: /^src\/.*\.upgrade\.ts$/,
    inputs: [...backendInputs, "apps/backend/vitest.upgrade.config.ts"],
    traceInputs: backendTraceInputs,
    env: [...backendEnv, { name: "RELEASE_TREE", mode: "presence" }],
    prerequisites: [
      "postgres",
      "falkordb",
      "bun",
      "zoekt",
      "ast-grep",
      "previous-release",
    ],
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
    prerequisites: ["zoekt"],
  },
  "codesearch-bun": {
    directory: "apps/codesearch",
    runtime: "bun",
    inputs: codesearchInputs,
    prerequisites: ["bun", "zoekt"],
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

// The files of a lane with its own config: the tracked files that match.
const matching = async (lane) => {
  const { stdout } = await promisify(execFile)(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: join(root, lanes[lane].directory), maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout.split("\n").filter((file) => lanes[lane].match.test(file))
}

// The Vitest checks: one for each test file of each lane.
export async function listVitest() {
  const suites = ["backend", "contracts", "vercel", "ui", "cli", "aws-cdk"]
  const [codesearch, latency, upgrade, ...inventories] = await Promise.all([
    json("apps/codesearch/scripts/run-vitest-contracts.mjs", ["--list"]),
    matching("latency"),
    matching("upgrade"),
    ...suites.map((lane) =>
      json("scripts/ci/test-suite.mjs", [lane, "--list"]),
    ),
  ])
  const files = Object.fromEntries(
    suites.map((lane, index) => [lane, inventories[index]]),
  )
  files.codesearch = codesearch.node
  files["codesearch-bun"] = codesearch.bun
  files.latency = latency
  files.upgrade = upgrade
  return Object.entries(files).flatMap(([lane, list]) =>
    list.map((relative) => {
      const file = `${lanes[lane].directory}/${relative}`
      const { inputs, runtime, env, traceInputs, prerequisites, stochastic } =
        lanes[lane]
      // An expensive check states its intent in a file next to it.
      const intent = join(root, file.replace(/\.[cm]?[jt]sx?$/, ".intent.md"))
      // A check id is `<family>:<lane>:<file>`. A later version adds case ids
      // as `<family>:<lane>:<file>#<case>`, so a file id stays a prefix.
      return {
        id: `vitest:${lane}:${file}`,
        family: "vitest",
        lane,
        root: lanes[lane].directory,
        file,
        inputs,
        runtime,
        ...(env && { env }),
        ...(traceInputs && { traceInputs }),
        ...(prerequisites && { prerequisites }),
        ...(stochastic && { stochastic }),
        ...(existsSync(intent) && {
          intent: readFileSync(intent, "utf8").trim(),
        }),
      }
    }),
  )
}

// A non-zero Vitest exit (an unhandled error, a teardown failure) fails every
// record that has not failed already, even when each assertion passed. The
// `origin` stays as suiteRecord set it: `runner` only for a record without a
// suite (the run gave no result). A test that passes but leaves an unhandled
// rejection has a suite, so its record gets no origin.
export function markExitFailure(records, run) {
  if (run.status === 0 && !run.error && !run.signal) return records
  const cause = run.error?.message ?? run.signal ?? `exit ${run.status}`
  return records.map((record) =>
    record.status === "failed" || (record.status === "error" && !record.origin)
      ? record
      : {
          ...record,
          status: "error",
          message: `Vitest failed (${cause}); see the log${record.message ? `. ${record.message}` : ""}`,
        },
  )
}

// Runs Vitest checks, one lane at a time: backend files share one database
// and run in series. With `trace`, it also returns the trace records.
export function runVitest(checks, trace) {
  const groups = Map.groupBy(checks, (check) => check.lane)
  const records = []
  const traced = []
  let traceFailed = false
  for (const [lane, laneChecks] of groups) {
    const { directory } = lanes[lane]
    const log = logFile(lane)
    const report = join(root, ".ci-results", "checks", `${lane}.json`)
    rmSync(report, { force: true })
    const laneConfig = { name: lane, ...lanes[lane] }
    let suites = new Map()
    let message
    let run
    for (const step of setupSteps(laneConfig, root)) {
      const setup = logged(log.path, process.execPath, step.args, {
        cwd: step.cwd,
        timeout: step.timeout,
      })
      if (setup.error || setup.status) {
        message = `${lane} setup failed`
        break
      }
    }
    // Bun has no V8 inspector, so a Bun lane has no trace.
    let parts =
      trace && laneConfig.runtime === "node"
        ? join(trace, `parts-${lane}`)
        : undefined
    if (parts) {
      parts = freshParts(parts, lane)
      if (!parts) traceFailed = true
    }
    if (!message) {
      const launch = vitestCommand(
        laneConfig,
        root,
        laneChecks.map(({ file }) => relative(directory, file)),
        report,
        parts,
      )
      run = logged(log.path, launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        timeout: 2_700_000,
      })
      try {
        suites = reportSuites(report)
      } catch {
        message = `Vitest wrote no report (${run.error?.message ?? run.signal ?? `exit ${run.status}`})`
      }
    }
    // A trace is data only: an error here never changes a result.
    if (parts)
      try {
        traced.push(...readParts(parts, lane))
      } catch (error) {
        traceFailed = true
        process.stderr.write(`No trace for ${lane}: ${error.message}\n`)
      }
    const laneRecords = laneChecks.map(({ id, file }) =>
      suiteRecord(id, suites.get(file), log.relative, message),
    )
    records.push(...(run ? markExitFailure(laneRecords, run) : laneRecords))
  }
  return { records, traced, traceFailed }
}

// The result record (schema/result.v1.schema.json, without schemaVersion) of
// one test file from its suite in a Vitest JSON report. No suite, a suite
// error or no case is an error: the file did not run.
export function suiteRecord(id, suite, log, message) {
  const cases = (suite?.assertionResults ?? []).map((assertion) => ({
    name: assertion.fullName,
    status:
      assertion.status === "passed" || assertion.status === "failed"
        ? assertion.status
        : "skipped",
    durationMs: Math.round(assertion.duration ?? 0),
    ...(assertion.failureMessages?.length
      ? { message: assertion.failureMessages.join("\n") }
      : {}),
  }))
  const status = !suite
    ? "error"
    : suite.message || !cases.length
      ? "error"
      : cases.some((c) => c.status === "failed")
        ? "failed"
        : cases.every((c) => c.status === "skipped")
          ? "skipped"
          : "passed"
  return {
    id,
    status,
    durationMs: suite
      ? Math.max(0, Math.round(suite.endTime - suite.startTime))
      : 0,
    cases,
    ...(log && { log }),
    // A suite that is in the report but did not run (a load error) is a
    // fault of the test file. Only a missing suite is a fault of the runner.
    ...(!suite && { origin: "runner" }),
    ...(status === "error"
      ? { message: suite?.message || message || "Suite did not run" }
      : {}),
  }
}

// The suites of a Vitest JSON report by repo-relative file path.
export function reportSuites(report) {
  const real = realpathSync(root)
  return new Map(
    JSON.parse(readFileSync(report, "utf8")).testResults.map((suite) => [
      relative(real, realpathSync(suite.name)).replaceAll("\\", "/"),
      suite,
    ]),
  )
}
