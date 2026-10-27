import { execFileSync } from "node:child_process"
import {
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"

// Trace files (schema/trace.v1.schema.json): for each check and test case,
// the source lines that the case executed. The runner collects them with
// trace-reporter.mjs and trace-worker.mjs. Usage:
//   trace.mjs merge <out> <trace>...
// merges trace files of one commit (for example the CI shards) into one.

const root = fileURLToPath(new URL("../../", import.meta.url))

// Empties the parts directory before a lane runs. A failure turns tracing
// off for the run: it returns undefined and writes one warning.
export function freshParts(parts, lane) {
  try {
    rmSync(parts, { recursive: true, force: true })
    return parts
  } catch (error) {
    process.stderr.write(`No trace for ${lane}: ${error.message}\n`)
    return undefined
  }
}

// Reads the part files that the trace workers of one lane wrote, and returns
// one check record for each test file. Removes the parts.
export function laneChecks(parts, lane) {
  let names = []
  try {
    names = readdirSync(parts)
  } catch {
    return []
  }
  const checks = new Map()
  const top = realpathSync(root)
  for (const name of names) {
    // `children/` holds the coverage of child processes.
    if (!name.endsWith(".json")) continue
    const part = JSON.parse(readFileSync(join(parts, name), "utf8"))
    const file = relative(top, realpathSync(part.file)).replaceAll("\\", "/")
    const id = `vitest:${lane}:${file}`
    // A retried file writes a second part; keep the last one.
    checks.set(id, {
      id,
      ...(part.recorded ? { recorded: part.recorded } : {}),
      cases: part.cases,
    })
  }
  rmSync(parts, { recursive: true, force: true })
  return [...checks.values()]
}

// The commit is the checkout that ran the checks; a reader maps line numbers
// with the diff from it. `durations` gives the time of each check that ran
// but has no trace record (a project check, a Bun lane).
export function writeTrace(
  path,
  checks,
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  durations = {},
) {
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const sorted = Object.fromEntries(
    Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  writeFileSync(
    path,
    gzipSync(
      JSON.stringify({
        schemaVersion: 1,
        commit,
        checks,
        ...(Object.keys(sorted).length && { durations: sorted }),
      }),
    ),
  )
}

function readTrace(path) {
  const trace = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"))
  if (trace.schemaVersion !== 1)
    throw new Error(`${path}: unknown schemaVersion ${trace.schemaVersion}`)
  return trace
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, out, ...inputs] = process.argv.slice(2)
    if (command !== "merge" || !out || !inputs.length)
      throw new Error("Usage: trace.mjs merge <out> <trace>...")
    const traces = inputs.map(readTrace)
    const commits = new Set(traces.map(({ commit }) => commit))
    if (commits.size !== 1)
      throw new Error(`Traces of more than one commit: ${[...commits]}`)
    const checks = traces.flatMap((trace) => trace.checks)
    const ids = [
      ...checks.map(({ id }) => id),
      ...traces.flatMap((trace) => Object.keys(trace.durations ?? {})),
    ]
    if (new Set(ids).size !== ids.length)
      throw new Error("The same check is in more than one trace")
    writeTrace(
      out,
      checks,
      [...commits][0],
      Object.assign({}, ...traces.map((trace) => trace.durations)),
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
