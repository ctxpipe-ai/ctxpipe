import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  freshParts,
  laneChecks,
  writeTrace,
} from "../../../scripts/checks/trace.mjs"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const root = fileURLToPath(new URL("../../../", import.meta.url))
const require = createRequire(join(cwd, "package.json"))
try {
  // --list prints the test files of each runtime as JSON and runs nothing.
  // --trace <dir> --commit <sha> also writes <dir>/trace.json.gz for the Node
  // runtime (scripts/checks/README.md). The commit is an argument, because
  // the Docker test image has no .git directory.
  const args = process.argv.slice(2)
  const listOnly = args.includes("--list")
  const option = (name) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  const trace = option("--trace")
  const commit = option("--commit")
  if ((trace === undefined) !== (commit === undefined) || (listOnly && trace))
    throw new Error(
      "Usage: run-vitest-contracts.mjs [--list | --trace <dir> --commit <sha>]",
    )
  if (!listOnly)
    for (const binary of ["node", "bun", "git"]) {
      process.stdout.write(
        `${binary}: ${execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()}\n`,
      )
    }
  const files = readdirSync(join(cwd, "src"), { recursive: true })
    .filter((file) => typeof file === "string" && file.endsWith(".test.ts"))
    .map((file) => `src/${file}`)
  const bun = [
    "src/domain/repositories/globFiles.test.ts",
    "src/routes/repo.test.ts",
    "src/domain/indexing/scipIndexers.native.test.ts",
    "src/domain/indexing/phases.credentials.test.ts",
    "src/domain/indexing/phases.plainGit.test.ts",
    "src/domain/indexing/phases.worktrees.test.ts",
  ]
  for (const file of bun)
    if (!files.includes(file)) throw new Error(`Missing Bun contract: ${file}`)
  if (listOnly) {
    const node = files.filter((file) => !bun.includes(file)).sort()
    process.stdout.write(`${JSON.stringify({ node, bun: [...bun].sort() })}\n`)
    process.exit()
  }
  const vitest = join(
    dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  )
  const directory = join(root, ".ci-results", "codesearch")
  mkdirSync(directory, { recursive: true })
  const baseline = join(directory, "no-allowed-failures.json")
  writeFileSync(baseline, JSON.stringify({ version: 1, failures: [] }))
  let failed = false
  for (const runtime of ["node", "bun"]) {
    const selected =
      runtime === "bun" ? bun : files.filter((file) => !bun.includes(file))
    const report = join(directory, `${runtime}.json`)
    const inventory = join(directory, `${runtime}-inventory.json`)
    writeFileSync(inventory, JSON.stringify(selected, null, 2))
    rmSync(report, { force: true })
    // Bun has no V8 inspector, so only the Node runtime has a trace.
    const parts =
      trace && runtime === "node"
        ? freshParts(join(trace, "parts-codesearch"), "codesearch")
        : undefined
    const result = spawnSync(
      runtime,
      [
        vitest,
        "run",
        ...selected,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
        ...(parts
          ? [`--reporter=${join(root, "scripts/checks/trace-reporter.mjs")}`]
          : []),
      ],
      {
        cwd,
        stdio: "inherit",
        timeout: 600_000,
        env: parts
          ? { ...process.env, CTXPIPE_TRACE_PARTS: parts }
          : process.env,
      },
    )
    if (result.error || result.signal)
      throw new Error(
        `Codesearch ${runtime} did not finish: ${result.error?.message ?? result.signal}`,
      )
    const checked = spawnSync(
      "node",
      [
        join(root, "scripts/ci/check-test-report.mjs"),
        report,
        baseline,
        String(result.status),
        inventory,
      ],
      {
        cwd,
        stdio: "inherit",
      },
    )
    if (checked.status !== 0) failed = true
    // The trace is data only: an error here never changes the result.
    if (parts)
      try {
        writeTrace(
          join(trace, "trace.json.gz"),
          laneChecks(parts, "codesearch"),
          commit,
        )
      } catch (error) {
        process.stderr.write(`No trace written: ${error.message}\n`)
      }
  }
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
