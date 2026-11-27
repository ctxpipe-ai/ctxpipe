import { execFile } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { setupSteps, vitestCommand } from "../ci/vitest-launch.mjs"
import { logDirectory, logFile, logged, loggedAsync } from "./log.mjs"
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
  "apps/backend/src/test/global-setup-converter.ts",
  "apps/backend/migrations/**",
  "scripts/ci/contracts.json",
  "scripts/ci/service-pins.json",
  "scripts/checks/prerequisites.mjs",
]
// The files that pin the tools and images of the native backend tests:
// the prerequisite check (it compares the OpenCode version with the declared
// one) and the chat sandbox image.
const nativeInputs = [
  "scripts/ci/prerequisites.mjs",
  "apps/backend/src/domain/workspaces/workspace-chat-opencode-contract.ts",
  "scripts/chat-sandbox/**",
  // The file converter that the knowledge-plane tests run (the
  // `converter` prerequisite builds it). Git lists no ignored `target/`.
  "apps/backend/converter/**",
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
  // The tests run in the codesearch test image on every host. The image pins
  // zoekt and the SCIP indexers; these files build and start it.
  "apps/codesearch/Dockerfile",
  "apps/codesearch/release-assets.txt",
  "apps/codesearch/start.sh",
  "apps/codesearch/scripts/**",
  "apps/codesearch/src/**",
  "patches/**",
  "scripts/checks/lanes.mjs",
  "scripts/ci/check-test-report.mjs",
]
// `traceInputs` names the inputs for which a reader with a trace may select
// from the trace instead of the whole lane (manifest.v1.schema.json).
// The migrations are Drizzle migration directories: `migration.sql`, which
// the tests apply, and `snapshot.json`, which only drizzle-kit reads.
const backendTraceInputs = { "apps/backend/migrations/**": "tables" }
// The named prerequisites (prerequisites.mjs) that the runner makes or
// verifies before a lane runs. The CI jobs set up the same things.
const databases = ["postgres", "migrations"]
const nativePrerequisites = [
  ...databases,
  "bun",
  "opencode",
  "zoekt",
  "ast-grep",
  "chat-sandbox-image",
  "contract-images",
]
// `portable`: the result does not depend on the OS or the CPU architecture,
// so a result cache leaves them out of the key and a pass on a laptop counts
// in CI (manifest.v1.schema.json). A lane is portable only when no file of it
// starts Docker or runs a host tool other than git and Node: such a file
// belongs to the contracts lane (the "not portable" group of
// scripts/ci/contracts.json). `programs`: the host tools that the lane runs;
// the key holds their versions.
// `serial`: the files of the lane share one database, so its Vitest config
// runs them in series (`fileParallelism: false`). The runner splits such a
// lane into shards, each on its own database (runVitest). In series, the
// full backend lane took 48 minutes and the full contracts lane 43 minutes on
// the agent host (CTX-1480).
const lanes = {
  backend: {
    directory: "apps/backend",
    runtime: "node",
    serial: true,
    inputs: [...backendInputs, ...nativeInputs],
    traceInputs: backendTraceInputs,
    env: backendEnv,
    prerequisites: nativePrerequisites,
    portable: true,
    programs: ["git"],
  },
  // Its files start Linux containers, so the key holds the platform of the
  // Docker server (container-platform), with the host tools that the lane
  // runs. The prerequisite pins the OpenCode version to a lane input. A file
  // that depends on the host itself is in scripts/checks/non-portable.json.
  contracts: {
    directory: "apps/backend",
    runtime: "node",
    serial: true,
    inputs: [...backendInputs, ...nativeInputs],
    traceInputs: backendTraceInputs,
    env: [...backendEnv, { name: "DOCKER_DEFAULT_PLATFORM", mode: "value" }],
    prerequisites: nativePrerequisites,
    portable: true,
    programs: ["git", "bun", "zoekt", "ast-grep", "container-platform"],
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
      "bun",
      "zoekt",
      "ast-grep",
      "previous-release",
    ],
    portable: true,
    programs: ["git", "zoekt", "ast-grep"],
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
    portable: true,
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
    portable: true,
    programs: ["git"],
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
    portable: true,
  },
  "visual-review": {
    directory: "packages/visual-review",
    runtime: "node",
    inputs: [
      ...shared,
      "packages/visual-review/package.json",
      "packages/visual-review/tsconfig.json",
      // The rubric test reads the design docs that the rubric cites.
      "apps/ui/DESIGN.md",
      ".agents/skills/product-ui/**",
    ],
    portable: true,
  },
  // Both lanes run in the Docker test image (zoekt and the SCIP indexers), on a
  // laptop as in CI (runCodesearchImage).
  // Both codesearch lanes run in the test image, so they are portable with
  // the platform of the Docker server in the key.
  codesearch: {
    directory: "apps/codesearch",
    runtime: "node",
    inputs: codesearchInputs,
    prerequisites: ["docker"],
    portable: true,
    programs: ["container-platform"],
  },
  "codesearch-bun": {
    directory: "apps/codesearch",
    runtime: "bun",
    inputs: codesearchInputs,
    prerequisites: ["docker"],
    portable: true,
    programs: ["container-platform"],
  },
}

// The host programs that one test file runs in addition to those of its lane.
const filePrograms = {
  // The ingest skill scripts run ast-grep.
  "apps/backend/src/domain/ingestion/apis-skill.test.ts": ["ast-grep"],
  "apps/backend/src/domain/ingestion/dependencies-skill.test.ts": ["ast-grep"],
  // It starts a Bun child process.
  "apps/backend/src/openworkflow/workflows/repository-ingestion-v2.integration.test.ts":
    ["bun"],
  // It runs the capture shell script with the host bash.
  "packages/cli/test/memory/memory-capture-sh.test.ts": ["bash"],
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
  const suites = [
    "backend",
    "contracts",
    "ui",
    "cli",
    "aws-cdk",
    "visual-review",
  ]
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
      const {
        inputs,
        runtime,
        env,
        traceInputs,
        prerequisites,
        stochastic,
        portable,
      } = lanes[lane]
      const programs = [
        ...(lanes[lane].programs ?? []),
        ...(filePrograms[file] ?? []),
      ]
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
        ...(portable && { portable }),
        ...(programs.length && { programs }),
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
  const cause = exitCause(run)
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

// Runs Vitest checks, one lane at a time. With `trace`, it also returns the
// trace records. The files of a serial lane share one database, so they run
// in series. With a host cap of Vitest workers (VITEST_MAX_WORKERS, which
// factory check sets), the runner splits a serial lane into that many shards,
// as CI does: each shard runs its files in series on its own database, and
// the shards run at the same time.
export async function runVitest(checks, trace) {
  const groups = Map.groupBy(checks, (check) => check.lane)
  const records = []
  const traced = []
  let traceFailed = false
  // Both codesearch lanes run in one container run, in the test image.
  const image = checks.filter(({ lane }) => codesearchLanes.includes(lane))
  if (image.length) records.push(...runCodesearchImage(image))
  for (const [lane, laneChecks] of groups) {
    if (codesearchLanes.includes(lane)) continue
    const log = logFile(lane)
    const laneConfig = { name: lane, ...lanes[lane] }
    let message
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
    if (message)
      records.push(
        ...laneChecks.map(({ id }) =>
          suiteRecord(id, undefined, log.relative, message),
        ),
      )
    else {
      const cap = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10)
      const byFile = new Map(
        laneChecks.map((check) => [
          relative(laneConfig.directory, check.file),
          check,
        ]),
      )
      const shards = shardFiles(
        lane,
        [...byFile.keys()],
        laneConfig.serial && cap > 1 ? Math.min(cap, byFile.size) : 1,
      )
      // The part files of the trace workers have the process id in their
      // name, so the shards can write to one part directory.
      const results = await Promise.all(
        shards.map((files, index) =>
          runShard(
            laneConfig,
            files.map((file) => byFile.get(file)),
            shards.length === 1
              ? { log }
              : { log: logFile(`${lane}-${index + 1}`), index: index + 1 },
            parts,
          ),
        ),
      )
      records.push(...results.flat())
    }
    // A trace is data only: an error here never changes a result.
    if (parts)
      try {
        traced.push(...readParts(parts, lane))
      } catch (error) {
        traceFailed = true
        process.stderr.write(`No trace for ${lane}: ${error.message}\n`)
      }
  }
  return { records, traced, traceFailed }
}

// The files of a lane in `count` shards, each in the order of `files`. A path
// is relative to the lane directory. The longest file goes first, to the
// shard with the least time. The measured seconds
// (scripts/ci/test-weights.json) only balance the shards; a stale or missing
// weight never drops a file. The CI shards (test-suite.mjs --shard) use the
// same split.
export function shardFiles(lane, files, count) {
  const weights =
    JSON.parse(
      readFileSync(join(root, "scripts/ci/test-weights.json"), "utf8"),
    )[lane] ?? {}
  const weight = (file) => 1 + (weights[file] ?? 0)
  const loads = Array(count).fill(0)
  const owners = new Map()
  for (const file of [...files].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const least = loads.indexOf(Math.min(...loads))
    loads[least] += weight(file)
    owners.set(file, least)
  }
  return loads.map((_, shard) =>
    files.filter((file) => owners.get(file) === shard),
  )
}

// Runs one Vitest process for the checks of one shard, and returns their
// records. A shard with an `index` runs on its own database: the runner
// makes it, applies the migrations, and drops it after the run.
async function runShard(laneConfig, checks, { log, index }, parts) {
  const reportDirectory = mkdtempSync(
    join(tmpdir(), `ctxpipe-${laneConfig.name}-`),
  )
  // The report is a file of this run only. Two runs on the same checkout
  // (parallel runners, or factory check next to checks:run) can run the
  // same lane at the same time. With one shared path, one run could read or
  // delete the report of the other.
  const report = join(reportDirectory, "report.json")
  let suites = new Map()
  let message
  let run
  let database
  try {
    if (index) {
      database = await shardDatabase(laneConfig, index, log.path)
      message = database.error
    }
    if (!message) {
      const launch = vitestCommand(
        laneConfig,
        root,
        checks.map(({ file }) => relative(laneConfig.directory, file)),
        report,
        parts,
      )
      run = await loggedAsync(log.path, launch.command, launch.args, {
        cwd: launch.cwd,
        env: {
          ...launch.env,
          ...(database && { DATABASE_URL: database.url }),
        },
        // A serial lane in one run (no host cap) runs all its files in
        // series: the full backend lane took 48 minutes on the agent host
        // (CTX-1480). A shard or a parallel lane has 45 minutes.
        timeout: laneConfig.serial && !index ? 7_200_000 : 2_700_000,
      })
      try {
        suites = reportSuites(report)
      } catch {
        message = `Vitest wrote no report (${exitCause(run)})`
      }
    }
  } catch (error) {
    // The other shards run on: one error fails only the checks of this one.
    message = `The ${laneConfig.name} shard ${index} did not run: ${error.message}`
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true })
    if (database?.drop) await database.drop()
  }
  const records = checks.map(({ id, file }) =>
    suiteRecord(id, suites.get(file), log.relative, message),
  )
  return run ? markExitFailure(records, run) : records
}

// The database of shard `index` of a serial lane:
// `<database of DATABASE_URL>_<pid of this runner>_<index>`, new and
// migrated with the migrations of this checkout. With the pid, two runs on
// one checkout do not share a shard database; a reset drops the shard
// databases that an ended runner left (apps/backend/src/db/test-database.ts).
// Returns `{ url, drop }`, or `{ error }`.
async function shardDatabase(laneConfig, index, log) {
  const url = new URL(process.env.DATABASE_URL)
  // Postgres keeps only the first 63 bytes of a name.
  const suffix = `_${process.pid}_${index}`
  const name = `${decodeURIComponent(url.pathname.slice(1)).slice(0, 63 - suffix.length)}${suffix}`
  url.pathname = `/${encodeURIComponent(name)}`
  const cwd = join(root, laneConfig.directory)
  const testDatabase = (command) =>
    loggedAsync(
      log,
      process.execPath,
      [
        createRequire(join(cwd, "package.json")).resolve("tsx/cli"),
        "src/db/test-database.ts",
        command,
      ],
      {
        cwd,
        env: { ...process.env, DATABASE_URL: url.toString() },
        timeout: 300_000,
      },
    )
  const reset = await testDatabase("reset")
  if (reset.error || reset.status)
    return {
      error: `The shard database ${name} was not made (${exitCause(reset)}); see the log`,
    }
  return { url: url.toString(), drop: () => testDatabase("drop") }
}

// Why a child process did not pass: its error, its signal or its exit code.
const exitCause = (run) => run.error?.message ?? run.signal ?? `exit ${run.status}`

const codesearchLanes = ["codesearch", "codesearch-bun"]

// Runs the codesearch lanes in the test image (zoekt and the SCIP indexers),
// as CI does, so that a laptop and CI give the same result. The image has the
// platform of the Docker server (run-vitest-docker.sh). The container runs the
// selected files in their runtime and writes one result record for each file.
// The lanes have no trace here.
export function runCodesearchImage(checks) {
  const log = logFile("codesearch")
  const directory = join(logDirectory(), "codesearch-records")
  rmSync(directory, { recursive: true, force: true })
  const run = logged(
    log.path,
    "bash",
    [
      join(root, "apps/codesearch/scripts/run-vitest-docker.sh"),
      "--records",
      directory,
      ...checks.flatMap(({ runtime, file }) => [
        `--${runtime}`,
        relative(join(root, "apps/codesearch"), join(root, file)),
      ]),
    ],
    { cwd: root, timeout: 2_700_000 },
  )
  const written = new Map()
  try {
    for (const line of readFileSync(join(directory, "records.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)) {
      const { schemaVersion: _, ...record } = JSON.parse(line)
      written.set(record.id, { ...record, log: log.relative })
    }
  } catch {}
  const message = `The codesearch image run wrote no result (${exitCause(run)})`
  const records = checks.map(
    ({ id }) =>
      written.get(id) ?? suiteRecord(id, undefined, log.relative, message),
  )
  return markExitFailure(records, run)
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
