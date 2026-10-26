import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { listChecks, runners } from "./families.mjs"
import { prepare } from "./prerequisites.mjs"
import { writeTrace } from "./trace.mjs"

// Runs the given check ids and writes one result record per id
// (schema/result.v1.schema.json) as NDJSON to stdout. Usage:
//   run.mjs [--trace <dir>] [ids-file]
// Without ids-file, the ids come from stdin, one per line. With --trace, it
// also writes <dir>/trace.json.gz (schema/trace.v1.schema.json).
// It first makes or verifies the prerequisites of the checks
// (prerequisites.mjs). A check whose prerequisite fails does not run.
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
  let failed = false
  const emit = (record) => {
    if (record.status === "failed" || record.status === "error") failed = true
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`)
  }
  const unrun = (id, message) =>
    emit({ id, status: "error", durationMs: 0, cases: [], message })
  const known = new Map((await listChecks()).checks.map((c) => [c.id, c]))
  const selected = []
  for (const id of ids) {
    if (known.has(id)) selected.push(known.get(id))
    else unrun(id, "Unknown check id")
  }
  const missing = await prepare(
    selected.flatMap((check) => check.prerequisites ?? []),
  )
  const groups = new Map()
  for (const check of selected) {
    const need = (check.prerequisites ?? []).find((name) => missing.has(name))
    if (need)
      unrun(check.id, `Prerequisite ${need} failed: ${missing.get(need)}`)
    else groups.set(check.family, [...(groups.get(check.family) ?? []), check])
  }
  const traced = []
  // The time of each check that ran but has no trace record.
  const durations = {}
  let traceFailed = false
  for (const [family, checks] of groups) {
    let result
    try {
      result = await runners[family](checks, trace)
    } catch (error) {
      for (const { id } of checks)
        unrun(id, `The ${family} run failed: ${error.message}`)
      continue
    }
    for (const record of result.records) emit(record)
    traced.push(...(result.traced ?? []))
    if (result.traceFailed) traceFailed = true
    const tracedIds = new Set(traced.map(({ id }) => id))
    for (const { id, status, durationMs } of result.records)
      if (status !== "error" && !tracedIds.has(id)) durations[id] = durationMs
  }
  // A partial trace would hide the cases of the failed lane, so write none.
  if (trace && !traceFailed)
    try {
      mkdirSync(trace, { recursive: true })
      writeTrace(join(trace, "trace.json.gz"), traced, undefined, durations)
    } catch (error) {
      process.stderr.write(`No trace written: ${error.message}\n`)
    }
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
