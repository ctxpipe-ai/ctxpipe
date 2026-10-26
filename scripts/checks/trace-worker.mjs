import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { Session } from "node:inspector"
import { join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterAll, afterEach, beforeEach } from "vitest"

import { emptyEdges, installEdges, takeEdges } from "./trace-edges.mjs"
import {
  executed,
  lineRanges,
  lineStarts,
  positionsOf as positionsIn,
} from "./trace-lines.mjs"

// A Vitest setup file. trace-reporter.mjs adds it to each project only when
// the runner traces. It records, for each test case, the repo source lines
// that the case executed, and writes one part file for each test file into
// the directory in CTXPIPE_TRACE_PARTS (set by the runner for its own Vitest).
// The code that runs before the first test and after the last test (module
// evaluation, beforeAll and afterAll) goes to the pseudo-case `<collect>`.
// A Node child process that a case starts writes its coverage to a directory
// of that case (NODE_V8_COVERAGE), and its lines go to that case too. The
// semantic edges come from trace-edges.mjs.

// A string, not `new URL()`: under jsdom, `URL` is the jsdom class.
const root = resolve(fileURLToPath(import.meta.url), "../../..")
const rootUrl = pathToFileURL(root).href
const collect = "<collect>"
const parts = process.env.CTXPIPE_TRACE_PARTS
if (!parts) throw new Error("trace-worker.mjs runs only under the check runner")

// Tracing must not change a result. If a step fails, the file writes no part,
// and a reader treats the file as not traced.
let failed = false
const stop = (error) => {
  failed = true
  process.stderr.write(`Trace stopped: ${error.message}\n`)
}

// One inspector session for each worker process. A worker that runs more
// than one test file evaluates this file again, so keep the state global.
let state
try {
  state = globalThis.__ctxpipeTrace ??= open()
} catch (error) {
  stop(error)
}

function open() {
  // The trace code itself is not traced. Not `new URL()`: under jsdom it
  // resolves against the page (`http://localhost:3000/@fs/...`).
  const own = [
    import.meta.url,
    ...["trace-edges.mjs", "trace-lines.mjs"].map(
      (name) =>
        pathToFileURL(resolve(fileURLToPath(import.meta.url), "..", name)).href,
    ),
  ]
  const session = new Session()
  session.connect()
  const scripts = new Map()
  session.on("Debugger.scriptParsed", ({ params }) => {
    if (
      params.url.startsWith(rootUrl) &&
      !params.url.includes("/node_modules/") &&
      !own.includes(params.url)
    )
      scripts.set(params.scriptId, params)
  })
  const post = (method, params) => {
    // A session in the same thread answers synchronously.
    let answer
    session.post(method, params, (error, result) => {
      answer = { error, result }
    })
    if (!answer) throw new Error(`${method} did not answer synchronously`)
    if (answer.error) throw answer.error
    return answer.result
  }
  post("Debugger.enable")
  post("Profiler.enable")
  post("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
  // A test can fake `performance` (vi.useFakeTimers), so keep the real clock.
  const clock = performance.now.bind(performance)
  return {
    post,
    clock,
    scripts,
    tables: new Map(),
    children: new Map(),
    code: new Map(),
    files: 0,
    recorded: undefined,
  }
}

// The kinds of semantic edges that this worker records. The hooks install
// once for each worker. `children` is added for each test file that
// collected child coverage.
if (state)
  try {
    state.recorded ??= await installEdges(root, `${resolve(parts)}${sep}`)
  } catch (error) {
    stop(error)
  }

const positionsOf = (script) => positionsIn(script, root, state.code)

// The positions of one script of this worker.
function table(scriptId) {
  if (state.tables.has(scriptId)) return state.tables.get(scriptId)
  const meta = state.scripts.get(scriptId)
  let result = null
  if (meta) {
    const { scriptSource } = state.post("Debugger.getScriptSource", {
      scriptId,
    })
    // Vitest wraps the transformed module in one line:
    // `'use strict';async (__vite_ssr_exports__, ...)=>{{`. The source map
    // describes the code after that prefix.
    const prefix = scriptSource.startsWith("'use strict';async (")
      ? scriptSource.indexOf("=>{{") + 4
      : 0
    const map = meta.sourceMapURL?.startsWith("data:application/json")
      ? JSON.parse(
          Buffer.from(
            meta.sourceMapURL.slice(meta.sourceMapURL.indexOf(",") + 1),
            "base64",
          ).toString("utf8"),
        )
      : null
    result = positionsOf({
      path: fileURLToPath(meta.url),
      text: scriptSource,
      starts: lineStarts(scriptSource),
      prefix,
      map,
    })
  }
  state.tables.set(scriptId, result)
  return result
}

// The positions of one script of a child process. Node writes the source
// map of a script, with the line lengths of the script, in the
// `source-map-cache` of the coverage file. A script without a map is read
// from disk.
function childTable(url, cached) {
  if (state.children.has(url)) return state.children.get(url)
  let result = null
  try {
    const path = fileURLToPath(url)
    if (cached?.data && cached.lineLengths) {
      const starts = [0]
      for (const length of cached.lineLengths)
        starts.push(starts.at(-1) + length + 1)
      result = positionsOf({
        path,
        starts,
        map: cached.data,
        base: cached.url?.startsWith("file:")
          ? fileURLToPath(cached.url)
          : path,
      })
    } else {
      const text = readFileSync(path, "utf8")
      result = positionsOf({ path, text, starts: lineStarts(text) })
    }
  } catch {
    // A script that is gone or that does not map gives no lines.
  }
  state.children.set(url, result)
  return result
}

// The lines that the Node child processes wrote to `dir` (NODE_V8_COVERAGE),
// and the number of coverage files that it read.
function childLines(dir) {
  const lines = new Map()
  let reports = 0
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { lines, reports }
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    let report
    try {
      report = JSON.parse(readFileSync(join(dir, name), "utf8"))
    } catch {
      continue
    }
    reports++
    const maps = report["source-map-cache"] ?? {}
    for (const script of report.result ?? []) {
      if (
        !script.url.startsWith(rootUrl) ||
        script.url.includes("/node_modules/")
      )
        continue
      const ranges = script.functions.flatMap((fn) => fn.ranges)
      if (!ranges.some((range) => range.count > 0)) continue
      const positions = childTable(script.url, maps[script.url])
      if (positions) executed(ranges, positions, lines)
    }
  }
  return { lines, reports }
}

// Takes the counts since the last take (V8 resets them) and adds the lines
// that ran to `lines` (source path to a set of line numbers).
function take(lines) {
  const { result } = state.post("Profiler.takePreciseCoverage")
  for (const script of result) {
    if (!state.scripts.has(script.scriptId)) continue
    const ranges = script.functions.flatMap((fn) => fn.ranges)
    if (!ranges.some((range) => range.count > 0)) continue
    const positions = table(script.scriptId)
    if (positions) executed(ranges, positions, lines)
  }
}

const cases = new Map()
const entry = (name) => {
  let known = cases.get(name)
  if (!known) {
    known = { lines: new Map(), durationMs: 0, edges: emptyEdges() }
    cases.set(name, known)
  }
  return known
}
const add = (name, lines, durationMs, edges) => {
  const known = entry(name)
  for (const [source, set] of lines) {
    const old = known.lines.get(source)
    if (old) for (const line of set) old.add(line)
    else known.lines.set(source, set)
  }
  known.durationMs += durationMs
  if (edges)
    for (const [kind, set] of Object.entries(edges))
      for (const value of set) known.edges[kind].add(value)
}
// The same name as `fullName` in the Vitest JSON report.
const fullName = (task) => {
  const names = []
  for (let suite = task.suite; suite; suite = suite.suite)
    names.unshift(suite.name)
  return [...names, task.name].join(" ")
}
const phase = (name) => {
  if (failed) return
  // The time of a phase does not include the take.
  const ms = state.clock() - mark
  const lines = new Map()
  try {
    take(lines)
  } catch (error) {
    stop(error)
  }
  add(name, lines, ms, takeEdges())
  mark = state.clock()
}
// Each case (and `<collect>`) has its own NODE_V8_COVERAGE directory. A Node
// child process reads the variable when it starts, and writes its coverage
// there when it exits. A child that the case starts with its own `env`, that
// a signal stops, or that is not Node, writes nothing.
const coverage = process.env.NODE_V8_COVERAGE
const children = join(
  parts,
  "children",
  `${process.pid}-${state ? ++state.files : 0}`,
)
const directories = new Map()
const childrenOf = (name) => {
  if (failed) return
  if (!directories.has(name))
    directories.set(name, join(children, String(directories.size)))
  process.env.NODE_V8_COVERAGE = directories.get(name)
}
// Counts and edges from before this file (an earlier file in the same
// worker, Vitest itself) do not belong to it.
let mark = state?.clock() ?? 0
phase(collect)
cases.clear()
childrenOf(collect)
beforeEach((context) => {
  phase(collect)
  childrenOf(fullName(context.task))
})
afterEach((context) => {
  phase(fullName(context.task))
  childrenOf(collect)
})
afterAll((suite) => {
  phase(collect)
  if (coverage === undefined) delete process.env.NODE_V8_COVERAGE
  else process.env.NODE_V8_COVERAGE = coverage
  if (failed) return
  try {
    // `children` only when a child wrote coverage: a check without it can
    // have a child that gave none (its own `env`, a signal, Bun).
    let reports = 0
    for (const [name, directory] of directories) {
      const child = childLines(directory)
      reports += child.reports
      add(name, child.lines, 0)
    }
    const sorted = (set) => [...set].sort()
    mkdirSync(parts, { recursive: true })
    writeFileSync(
      join(parts, `${process.pid}-${state.files}.json`),
      JSON.stringify({
        file: suite.filepath,
        recorded: reports ? ["children", ...state.recorded] : state.recorded,
        cases: [...cases].map(([name, { lines, durationMs, edges }]) => {
          const tables = {
            ...(edges.read.size ? { read: sorted(edges.read) } : {}),
            ...(edges.write.size ? { write: sorted(edges.write) } : {}),
          }
          const lists = ["routes", "steps", "tools", "reads", "dirs"]
          return {
            name,
            durationMs: Math.max(0, Math.round(durationMs)),
            lines: lineRanges(lines, state.code),
            ...(Object.keys(tables).length ? { tables } : {}),
            ...Object.fromEntries(
              lists
                .filter((kind) => edges[kind].size)
                .map((kind) => [kind, sorted(edges[kind])]),
            ),
          }
        }),
      }),
    )
  } catch (error) {
    stop(error)
  }
})
