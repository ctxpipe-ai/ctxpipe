import { mkdirSync, writeFileSync } from "node:fs"
import { Session } from "node:inspector"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { decode } from "@jridgewell/sourcemap-codec"
import { afterAll, afterEach, beforeEach } from "vitest"

// A Vitest setup file. trace-reporter.mjs adds it to each project only when
// the runner traces. It records, for each test case, the repo source lines
// that the case executed, and writes one part file for each test file into
// the directory in CTXPIPE_TRACE_PARTS (set by the runner for its own Vitest).
// The code that runs before the first test and after the last test (module
// evaluation, beforeAll and afterAll) goes to the pseudo-case `<collect>`.

// A string, not `new URL()`: under jsdom, `URL` is the jsdom class.
const root = resolve(fileURLToPath(import.meta.url), "../../..")
const rootUrl = pathToFileURL(root).href
const collect = "<collect>"

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
  const session = new Session()
  session.connect()
  const scripts = new Map()
  session.on("Debugger.scriptParsed", ({ params }) => {
    if (
      params.url.startsWith(rootUrl) &&
      !params.url.includes("/node_modules/") &&
      params.url !== import.meta.url
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
  return { post, scripts, tables: new Map(), code: new Map() }
}

// The source position of each source map segment of one script, sorted by
// offset in the script that V8 ran.
function table(scriptId) {
  if (state.tables.has(scriptId)) return state.tables.get(scriptId)
  const meta = state.scripts.get(scriptId)
  let result = null
  if (meta) {
    const { scriptSource } = state.post("Debugger.getScriptSource", {
      scriptId,
    })
    const starts = [0]
    let newline = scriptSource.indexOf("\n")
    while (newline !== -1) {
      starts.push(newline + 1)
      newline = scriptSource.indexOf("\n", newline + 1)
    }
    // Vitest wraps the transformed module in one line:
    // `'use strict';async (__vite_ssr_exports__, ...)=>{{`. The source map
    // describes the code after that prefix.
    const prefix = scriptSource.startsWith("'use strict';async (")
      ? scriptSource.indexOf("=>{{") + 4
      : 0
    const offsets = []
    const sources = []
    const lines = []
    const scriptPath = fileURLToPath(meta.url)
    const map = meta.sourceMapURL?.startsWith("data:application/json")
      ? JSON.parse(
          Buffer.from(
            meta.sourceMapURL.slice(meta.sourceMapURL.indexOf(",") + 1),
            "base64",
          ).toString("utf8"),
        )
      : null
    if (map) {
      const names = map.sources.map((source) => {
        const path = isAbsolute(source)
          ? source
          : resolve(scriptPath, "..", map.sourceRoot ?? "", source)
        return repoPath(path)
      })
      for (const [line, segments] of decode(map.mappings).entries())
        for (const [column, source, sourceLine] of segments) {
          if (source === undefined || !names[source]) continue
          offsets.push(starts[line] + column + (line === 0 ? prefix : 0))
          sources.push(names[source])
          lines.push(sourceLine + 1)
        }
    } else {
      // No source map: the script is the source. Use the first character of
      // each line that is not white space.
      const name = repoPath(scriptPath)
      for (const [line, start] of starts.entries()) {
        const from = start + (line === 0 ? prefix : 0)
        const end = starts[line + 1] ?? scriptSource.length
        const text = scriptSource.slice(from, end)
        const indent = text.search(/\S/)
        if (!name || indent === -1) continue
        offsets.push(from + indent)
        sources.push(name)
        lines.push(line + 1)
      }
    }
    for (const [index, source] of sources.entries()) {
      if (!state.code.has(source)) state.code.set(source, new Set())
      state.code.get(source).add(lines[index])
    }
    result = { offsets, sources, lines }
  }
  state.tables.set(scriptId, result)
  return result
}

function repoPath(path) {
  const name = relative(root, path).replaceAll("\\", "/")
  return name.startsWith("..") || name.includes("node_modules/") ? null : name
}

// Takes the counts since the last take (V8 resets them) and adds the lines
// that ran to `lines` (source path to a set of line numbers). A segment ran
// when the innermost V8 range that holds its offset has a count above zero:
// the function ranges minus their nested blocks with a zero count.
function take(lines) {
  const { result } = state.post("Profiler.takePreciseCoverage")
  for (const script of result) {
    if (!state.scripts.has(script.scriptId)) continue
    const ranges = script.functions.flatMap((fn) => fn.ranges)
    if (!ranges.some((range) => range.count > 0)) continue
    const positions = table(script.scriptId)
    if (!positions) continue
    ranges.sort(
      (a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset,
    )
    const stack = []
    let next = 0
    for (const [index, offset] of positions.offsets.entries()) {
      while (next < ranges.length && ranges[next].startOffset <= offset) {
        const range = ranges[next++]
        while (stack.length && stack.at(-1).endOffset <= range.startOffset)
          stack.pop()
        stack.push(range)
      }
      while (stack.length && stack.at(-1).endOffset <= offset) stack.pop()
      if (!stack.length || stack.at(-1).count === 0) continue
      const source = positions.sources[index]
      if (!lines.has(source)) lines.set(source, new Set())
      lines.get(source).add(positions.lines[index])
    }
  }
}

// Line sets to sorted [start, end] ranges. A line with no code (blank, a
// comment, a type) does not end a range.
function ranges(lines) {
  const out = {}
  for (const [source, set] of [...lines].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const code = state.code.get(source)
    const sorted = [...set].sort((a, b) => a - b)
    const list = []
    for (const line of sorted) {
      const last = list.at(-1)
      if (last) {
        let gap = true
        for (let between = last[1] + 1; between < line && gap; between++)
          if (code.has(between)) gap = false
        if (gap) {
          last[1] = line
          continue
        }
      }
      list.push([line, line])
    }
    out[source] = list
  }
  return out
}

const parts = process.env.CTXPIPE_TRACE_PARTS
if (!parts) throw new Error("trace-worker.mjs runs only under the check runner")
const cases = new Map()
const add = (name, lines, durationMs) => {
  const entry = cases.get(name) ?? { lines: new Map(), durationMs: 0 }
  for (const [source, set] of lines) {
    const known = entry.lines.get(source)
    if (known) for (const line of set) known.add(line)
    else entry.lines.set(source, set)
  }
  entry.durationMs += durationMs
  cases.set(name, entry)
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
  const ms = performance.now() - mark
  const lines = new Map()
  try {
    take(lines)
  } catch (error) {
    stop(error)
  }
  add(name, lines, ms)
  mark = performance.now()
}
// Counts from before this file (an earlier file in the same worker, Vitest
// itself) do not belong to it.
let mark = performance.now()
phase(collect)
cases.clear()
beforeEach(() => phase(collect))
afterEach((context) => phase(fullName(context.task)))
afterAll((suite) => {
  phase(collect)
  if (failed) return
  try {
    mkdirSync(parts, { recursive: true })
    writeFileSync(
      join(parts, `${process.pid}-${performance.now().toFixed(3)}.json`),
      JSON.stringify({
        file: suite.filepath,
        cases: [...cases].map(([name, { lines, durationMs }]) => ({
          name,
          durationMs: Math.round(durationMs),
          lines: ranges(lines),
        })),
      }),
    )
  } catch (error) {
    stop(error)
  }
})
