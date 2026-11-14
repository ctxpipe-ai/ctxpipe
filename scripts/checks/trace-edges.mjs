import fs from "node:fs"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { noteTables } from "./trace-tables.mjs"

// The semantic edges of a test case: the operations that it used, in the
// Vitest worker process. trace-worker.mjs installs the hooks once in each
// worker, and takes the edges at the end of each phase with `takeEdges()`.
// Each hook records names only: table names, route patterns, step names, tool
// names and repo paths. It never records SQL text, request
// data, prompt text or arguments. A hook that cannot install (the lane does
// not use the package, or the package changed) records nothing, and its kind
// is not in `recorded`. Then a reader must treat that kind as unknown.

export const emptyEdges = () => ({
  read: new Set(),
  write: new Set(),
  routes: new Set(),
  steps: new Set(),
  tools: new Set(),
  reads: new Set(),
  dirs: new Set(),
})
let edges = emptyEdges()

// Returns the edges since the last take, and starts new sets.
export function takeEdges() {
  const taken = edges
  edges = emptyEdges()
  return taken
}

// Installs the hooks. `root` is the repo root; `skip` is a directory whose
// reads are not recorded (the trace output). Returns the kinds that installed.
export async function installEdges(root, skip) {
  const recorded = []
  const lane = createRequire(join(process.cwd(), "package.json"))
  const hooks = {
    reads: () => hookFiles(root, skip),
    tables: () => hookPg(lane),
    routes: () => hookHono(lane),
    steps: () => hookOpenWorkflow(lane),
    tools: () => hookMcp(lane),
  }
  for (const [kind, hook] of Object.entries(hooks))
    try {
      await hook()
      // The fs hook records both `reads` and `dirs`.
      recorded.push(...(kind === "reads" ? ["reads", "dirs"] : [kind]))
    } catch {
      // The lane does not use this package, or the package changed: the
      // kind stays unknown for this lane.
    }
  return recorded
}

// The directory of a package as the lane resolves it, so that the hook
// patches the same module instance that the code under test loads. `probe`
// is a specifier of the package that `require` can resolve.
function packageDir(lane, name, probe = name) {
  const entry = lane.resolve(probe)
  const marker = `${sep}node_modules${sep}${name.replaceAll("/", sep)}${sep}`
  const at = entry.lastIndexOf(marker)
  if (at === -1) throw new Error(`${name}: no package directory`)
  return entry.slice(0, at + marker.length)
}

// Imports an ESM file of a package by path. Vitest loads packages from
// node_modules natively, so this is the module that the code under test uses.
const esm = (lane, name, file, probe) =>
  import(pathToFileURL(join(packageDir(lane, name, probe), file)).href)

// SQL tables, from the node-postgres client that the backend and Drizzle use.
// The table names come from the statement text; the text is not kept. Only
// queries count (select, insert, update, delete). Schema statements (a test
// that applies the migrations) and `truncate` (cleanup) do not show what a
// case uses; a test that applies migrations reads them, so `reads` has it.
// A recording failure turns the edge off for that call; the query itself
// always runs unchanged.
function hookPg(lane) {
  const { Client } = lane("pg")
  const query = Client.prototype.query
  Client.prototype.query = function (config, ...rest) {
    try {
      const text = typeof config === "string" ? config : config?.text
      if (typeof text === "string") noteTables(text, edges)
    } catch {
      // The tables of this query are not recorded.
    }
    return query.call(this, config, ...rest)
  }
}

// HTTP route patterns of Hono apps (backend, codesearch): each route handler
// that runs records `<METHOD> <pattern>`. Middleware (method ALL, a pattern
// that ends in `*`) is not recorded. A recording failure never changes the
// call or its result.
async function hookHono(lane) {
  const wrapped = new WeakSet()
  let routers = 0
  for (const name of ["smart", "reg-exp", "trie", "linear", "pattern"]) {
    let router
    try {
      router = Object.values(
        await esm(lane, "hono", `dist/router/${name}-router/router.js`),
      )[0]
    } catch {
      continue
    }
    const add = router.prototype.add
    router.prototype.add = function (method, path, tuple, ...rest) {
      if (Array.isArray(tuple) && !wrapped.has(tuple)) {
        wrapped.add(tuple)
        const [handler, route] = tuple
        if (
          typeof handler === "function" &&
          route &&
          !(route.method === "ALL" && route.path.endsWith("*"))
        ) {
          const pattern = `${route.method} ${route.path}`
          tuple[0] = function (...args) {
            try {
              edges.routes.add(pattern)
            } catch {
              // The route of this call is not recorded.
            }
            return handler.apply(this, args)
          }
        }
      }
      return add.call(this, method, path, tuple, ...rest)
    }
    routers++
  }
  if (!routers) throw new Error("hono: no router")
}

// OpenWorkflow step names: each step resolves its name once per run. A
// name can add run data after `:` (`publish:<workspace id>`), so only the
// part before the first `:` is recorded.
async function hookOpenWorkflow(lane) {
  const { StepHistory } = await esm(
    lane,
    "openworkflow",
    "dist/worker/step-history.js",
  )
  const resolveStepName = StepHistory.prototype.resolveStepName
  StepHistory.prototype.resolveStepName = function (name, ...rest) {
    if (typeof name === "string") edges.steps.add(name.split(":")[0])
    return resolveStepName.call(this, name, ...rest)
  }
}

// MCP tool names: the SDK validates the input of each tool call.
async function hookMcp(lane) {
  const { McpServer } = await esm(
    lane,
    "@modelcontextprotocol/sdk",
    "dist/esm/server/mcp.js",
    "@modelcontextprotocol/sdk/server/mcp.js",
  )
  const validate = McpServer.prototype.validateToolInput
  McpServer.prototype.validateToolInput = function (tool, args, name) {
    if (typeof name === "string") edges.tools.add(name)
    return validate.call(this, tool, args, name)
  }
}

// Repo files that a case reads through `fs` (`reads`), and the repo
// directories that it lists (`dirs`). Code that
// Node loads with `require` is read through `fs.readFileSync` too, so the
// list can hold code files; their lines are in the trace already.
function hookFiles(root, skip) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  const note = (path, directory) => {
    let name
    if (typeof path === "string") name = path
    else if (path instanceof URL) name = fileURLToPath(path)
    else if (Buffer.isBuffer(path)) name = path.toString("utf8")
    else return
    const full = resolve(name)
    if (!full.startsWith(prefix) || full.startsWith(skip)) return
    const repo = relative(root, full).replaceAll("\\", "/")
    if (/(^|\/)(node_modules|\.git|\.ci-results)(\/|$)/.test(repo)) return
    ;(directory ? edges.dirs : edges.reads).add(repo)
  }
  // A recursive listing lists the directories below it too: record each
  // directory that holds an entry of the result.
  const below = (path, options, entries) => {
    if (!options?.recursive || !Array.isArray(entries)) return
    const base = path instanceof URL ? fileURLToPath(path) : String(path)
    for (const entry of entries) {
      const name =
        typeof entry === "object" && "name" in entry ? null : String(entry)
      let directory =
        name === null
          ? (entry.parentPath ?? entry.path)
          : dirname(join(base, name))
      while (directory && directory.length > base.length) {
        note(directory, true)
        directory = dirname(directory)
      }
    }
  }
  const wrap = (target, method, directory, result) => {
    const original = target[method]
    target[method] = function (path, ...rest) {
      try {
        note(path, directory)
      } catch {
        // A path that does not resolve is not recorded.
      }
      const value = original.call(this, path, ...rest)
      if (result)
        try {
          result(path, rest[0], value)
        } catch {
          // The listing itself is recorded already.
        }
      return value
    }
  }
  const later = (path, options, promise) =>
    promise.then(
      (entries) => below(path, options, entries),
      () => {},
    )
  for (const method of ["readFileSync", "readFile", "createReadStream"])
    wrap(fs, method, false)
  wrap(fs, "readdirSync", true, below)
  for (const method of ["readdir", "opendirSync", "opendir"])
    wrap(fs, method, true)
  wrap(fs.promises, "readFile", false)
  wrap(fs.promises, "readdir", true, later)
  wrap(fs.promises, "opendir", true)
  // `import { readFileSync } from "node:fs"` reads the patched function.
  syncBuiltinESMExports()
}
