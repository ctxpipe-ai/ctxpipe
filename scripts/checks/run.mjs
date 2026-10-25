import { spawnSync } from "node:child_process"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, relative, resolve } from "node:path"

import { setupSteps, vitestCommand } from "../ci/vitest-launch.mjs"
import { lanes, listChecks, root } from "./lanes.mjs"
import { freshParts, laneChecks, writeTrace } from "./trace.mjs"

// Runs the given check ids and writes one result record per id
// (schema/result.v1.schema.json) as NDJSON to stdout. Usage:
//   run.mjs [--trace <dir>] [ids-file]
// Without ids-file, the ids come from stdin, one per line. With --trace, it
// also writes <dir>/trace.json.gz (schema/trace.v1.schema.json).
// This is the subset path. It does not compare the executed files with the
// full CI inventory or the failure baseline; test-suite.mjs still does that.
try {
  const args = process.argv.slice(2)
  const traceAt = args.indexOf("--trace")
  const trace = traceAt === -1 ? undefined : resolve(args[traceAt + 1] ?? "")
  if (traceAt !== -1) args.splice(traceAt, 2)
  if (args.length > 1 || (traceAt !== -1 && !trace.length))
    throw new Error("Usage: run.mjs [--trace <dir>] [ids-file]")
  const ids = [
    ...new Set(
      readFileSync(args[0] ?? 0, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ]
  const emit = (record) =>
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`)
  const known = new Map((await listChecks()).checks.map((c) => [c.id, c]))
  const groups = new Map()
  let failed = false
  for (const id of ids) {
    const check = known.get(id)
    if (!check) {
      emit({
        id,
        status: "error",
        durationMs: 0,
        cases: [],
        message: "Unknown check id",
      })
      failed = true
      continue
    }
    groups.set(check.lane, [...(groups.get(check.lane) ?? []), check])
  }
  const results = resolve(root, ".ci-results", "checks")
  mkdirSync(results, { recursive: true })
  const traced = []
  let traceFailed = false
  // One lane at a time: backend files share one database and run in series.
  for (const [lane, checks] of groups) {
    const { directory } = lanes[lane]
    const log = join(results, `${lane}.log`)
    const report = join(results, `${lane}.json`)
    rmSync(report, { force: true })
    writeFileSync(log, "")
    // The Vitest output goes to the log; stdout carries only result records.
    const logged = (command, commandArgs, options = {}) => {
      writeFileSync(log, `$ ${command} ${commandArgs.join(" ")}\n`, {
        flag: "a",
      })
      const fd = openSync(log, "a")
      try {
        return spawnSync(command, commandArgs, {
          stdio: ["ignore", fd, fd],
          ...options,
        })
      } finally {
        closeSync(fd)
      }
    }
    const laneConfig = { name: lane, ...lanes[lane] }
    let suites = new Map()
    let message
    for (const step of setupSteps(laneConfig, root)) {
      const setup = logged(process.execPath, step.args, {
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
        checks.map(({ file }) => relative(directory, file)),
        report,
        parts,
      )
      const run = logged(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        timeout: 2_700_000,
      })
      try {
        const parsed = JSON.parse(readFileSync(report, "utf8"))
        suites = new Map(
          parsed.testResults.map((suite) => [
            relative(realpathSync(root), realpathSync(suite.name)).replaceAll(
              "\\",
              "/",
            ),
            suite,
          ]),
        )
      } catch {
        message = `Vitest wrote no report (${run.error?.message ?? run.signal ?? `exit ${run.status}`})`
      }
    }
    // A trace is data only: an error here never changes a result.
    if (parts)
      try {
        traced.push(...laneChecks(parts, lane))
      } catch (error) {
        traceFailed = true
        process.stderr.write(`No trace for ${lane}: ${error.message}\n`)
      }
    for (const { id, file } of checks) {
      const suite = suites.get(file)
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
      if (status === "failed" || status === "error") failed = true
      emit({
        id,
        status,
        durationMs: suite
          ? Math.max(0, Math.round(suite.endTime - suite.startTime))
          : 0,
        cases,
        log: relative(root, log),
        ...(status === "error"
          ? { message: suite?.message || message || "Suite did not run" }
          : {}),
      })
    }
  }
  // A partial trace would hide the cases of the failed lane, so write none.
  if (trace && !traceFailed)
    try {
      mkdirSync(trace, { recursive: true })
      writeTrace(join(trace, "trace.json.gz"), traced)
    } catch (error) {
      process.stderr.write(`No trace written: ${error.message}\n`)
    }
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
