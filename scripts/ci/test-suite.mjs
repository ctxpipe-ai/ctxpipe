import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { freshParts, laneChecks, writeTrace } from "../checks/trace.mjs"
import { setupSteps, vitestCommand } from "./vitest-launch.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const packages = {
  backend: "apps/backend",
  contracts: "apps/backend",
  vercel: "apps/backend",
  ui: "apps/ui",
  cli: "packages/cli",
  "aws-cdk": "packages/aws-cdk",
}
try {
  const [name, ...extra] = process.argv.slice(2)
  const listOnly = extra.includes("--list")
  const merge = extra.includes("--merge")
  // --trace also writes trace.json.gz next to results.json: the lines that
  // each test case executed (scripts/checks/README.md). It is data only and
  // does not change the result.
  const trace = extra.includes("--trace")
  const shardArgument = extra.find((arg) => arg.startsWith("--shard="))
  const shard = /^--shard=([1-9]\d*)\/([1-9]\d*)$/
    .exec(shardArgument ?? "")
    ?.slice(1)
    .map(Number)
  // CI splits the two serial lanes over parallel jobs; see ci.yaml.
  const sharded = name === "backend" || name === "contracts"
  if (
    !packages[name] ||
    extra.some(
      (arg) => ![`--list`, `--merge`, `--trace`, shardArgument].includes(arg),
    ) ||
    extra.length !== new Set(extra).size ||
    (shardArgument && (!shard || shard[0] > shard[1] || !sharded)) ||
    (merge && (shardArgument || listOnly || trace || !sharded)) ||
    (listOnly && trace)
  )
    throw new Error(
      "Usage: test-suite.mjs backend|contracts|vercel|ui|cli|aws-cdk [--list | --trace]\n" +
        "       test-suite.mjs backend|contracts [--shard=i/N] [--list | --trace] | --merge",
    )
  const cwd = join(root, packages[name])
  const run = (script, args = [], directory = root) => {
    const result = spawnSync(process.execPath, [join(root, script), ...args], {
      cwd: directory,
      stdio: "inherit",
      timeout: 300_000,
    })
    if (result.error)
      throw new Error(`${script} did not finish: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`${script} failed`)
  }
  const baseline = `scripts/ci/failures/${name}.json`
  let files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file))
  if (!files.length) throw new Error(`No required tests found for ${name}`)
  let selection = []
  if (name === "backend" || name === "contracts" || name === "vercel") {
    const lanes = JSON.parse(
      readFileSync(join(root, "scripts/ci/contracts.json"), "utf8"),
    )
    // Real Vercel sandboxes need the deploy credentials, so that lane runs in
    // its own job; the other suites never select it.
    const hosted = new Set(lanes["hosted sandbox (Vercel)"] ?? [])
    const contracts = new Set(Object.values(lanes).flat())
    for (const [lane, required] of Object.entries(lanes)) {
      if (
        !listOnly &&
        name === "contracts" &&
        !required.some((file) => hosted.has(file))
      )
        process.stdout.write(`CONTRACT ${lane}: ${required.join(", ")}\n`)
      for (const file of required)
        if (!files.includes(file))
          throw new Error(`Missing required ${lane} contract: ${file}`)
    }
    // CI runs both lanes. Keep the full discovered inventory, but execute each
    // file once; the contract lane retains its stricter zero-failure baseline.
    selection = files.filter((file) =>
      name === "vercel"
        ? hosted.has(file)
        : !hosted.has(file) && contracts.has(file) === (name === "contracts"),
    )
    files = selection
  }
  if (!files.length) throw new Error(`No required tests selected for ${name}`)
  const resultsRoot = resolve(
    root,
    process.env.CI_TEST_RESULTS_DIR ?? ".ci-results",
    name,
  )
  if (shard) {
    // Longest file first to the least loaded shard. The measured seconds only
    // balance the shards; a stale or missing weight never drops a file.
    const [index, count] = shard
    const weights =
      JSON.parse(
        readFileSync(join(root, "scripts/ci/test-weights.json"), "utf8"),
      )[name] ?? {}
    const weight = (file) => 1 + (weights[file] ?? 0)
    const loads = Array(count).fill(0)
    const owners = new Map()
    for (const file of [...files].sort(
      (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
    )) {
      const least = loads.indexOf(Math.min(...loads))
      loads[least] += weight(file)
      owners.set(file, least + 1)
    }
    files = files.filter((file) => owners.get(file) === index)
    selection = files
    if (!files.length) throw new Error(`Shard ${index}/${count} is empty`)
  }
  if (merge) {
    // Each shard job stores results.json and exit-code; check their union
    // against the full inventory with the full failure baseline.
    const shards = readdirSync(resultsRoot)
      .map((entry) => /^shard-(\d+)-of-(\d+)$/.exec(entry))
      .filter(Boolean)
    if (
      !shards.length ||
      shards.some(([, , count]) => Number(count) !== shards.length) ||
      shards
        .map(([, index]) => Number(index))
        .sort((a, b) => a - b)
        .some((index, position) => index !== position + 1)
    )
      throw new Error(`Incomplete ${name} shards in ${resultsRoot}`)
    const counters = [
      "numTotalTests",
      "numPassedTests",
      "numFailedTests",
      "numPendingTests",
      "numTodoTests",
    ]
    const merged = Object.fromEntries(counters.map((key) => [key, 0]))
    merged.testResults = []
    let status = 0
    for (const [entry] of shards) {
      const report = JSON.parse(
        readFileSync(join(resultsRoot, entry, "results.json"), "utf8"),
      )
      for (const key of counters) merged[key] += report[key]
      merged.testResults.push(...report.testResults)
      status = Math.max(
        status,
        Number(readFileSync(join(resultsRoot, entry, "exit-code"), "utf8")),
      )
    }
    const report = join(resultsRoot, "results.json")
    const inventory = join(resultsRoot, "inventory.json")
    writeFileSync(report, JSON.stringify(merged))
    writeFileSync(inventory, `${JSON.stringify(files, null, 2)}\n`)
    run(
      "scripts/ci/check-test-report.mjs",
      [report, join(root, baseline), String(status), inventory],
      cwd,
    )
  } else if (listOnly) {
    process.stdout.write(`${JSON.stringify(files.sort(), null, 2)}\n`)
  } else {
    if (name === "backend" || name === "contracts")
      run("scripts/ci/prerequisites.mjs")
    run("scripts/ci/check-allowlist-history.mjs", [baseline])
    const output = shard
      ? join(resultsRoot, `shard-${shard[0]}-of-${shard[1]}`)
      : resultsRoot
    mkdirSync(output, { recursive: true })
    const inventory = join(output, "inventory.json")
    const report = join(output, "results.json")
    rmSync(report, { force: true })
    writeFileSync(inventory, `${JSON.stringify(files, null, 2)}\n`)
    const lane = { name, directory: packages[name], runtime: "node" }
    for (const step of setupSteps(lane, root)) {
      const built = spawnSync(process.execPath, step.args, {
        cwd: step.cwd,
        stdio: "inherit",
        timeout: step.timeout,
      })
      if (built.error || built.status !== 0)
        throw new Error(`Required ${name} setup failed`)
    }
    const parts = trace ? freshParts(join(output, "trace-parts"), name) : undefined
    const launch = vitestCommand(lane, root, selection, report, parts)
    const result = spawnSync(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "inherit",
      // Native contracts include real lease expiry and resource cleanup deadlines.
      // Each file runs in exactly one lane. Ownership contracts add real lease
      // expiry and writer-loss recovery; 30 minutes once killed the contract
      // suite before Failed Tests. Only that lane needs the extra ceiling.
      timeout:
        name === "backend"
          ? 1_800_000
          : name === "contracts"
            ? 2_700_000
            : 600_000,
    })
    if (result.error || result.signal)
      throw new Error(
        `Test runner did not finish: ${result.error?.message ?? result.signal}`,
      )
    writeFileSync(join(output, "exit-code"), String(result.status))
    if (parts)
      try {
        writeTrace(join(output, "trace.json.gz"), laneChecks(parts, name))
      } catch (error) {
        process.stderr.write(`No trace written: ${error.message}\n`)
      }
    // A shard checks only the allowances for its own files. The merge step
    // checks the full baseline against the union of the shards.
    let shardBaseline = join(root, baseline)
    if (shard) {
      const { version, failures } = JSON.parse(
        readFileSync(shardBaseline, "utf8"),
      )
      shardBaseline = join(output, "baseline.json")
      writeFileSync(
        shardBaseline,
        JSON.stringify({
          version,
          failures: failures.filter(({ file }) => files.includes(file)),
        }),
      )
    }
    run(
      "scripts/ci/check-test-report.mjs",
      [report, shardBaseline, String(result.status), inventory],
      cwd,
    )
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
