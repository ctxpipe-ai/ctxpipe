import fs from "node:fs"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// The semantic edges of a test case: the operations that it used, in the
// Vitest worker process. trace-worker.mjs installs the hooks once in each
// worker, and takes the edges at the end of each phase with `takeEdges()`.
// Each hook records names only: table names, route patterns, step names, tool
// names, generation names and repo paths. It never records SQL text, request
// data, prompt text or arguments. A hook that cannot install (the lane does
// not use the package, or the package changed) records nothing, and its kind
// is not in `recorded`. Then a reader must treat that kind as unknown.

export const emptyEdges = () => ({
  read: new Set(),
  write: new Set(),
  routes: new Set(),
  steps: new Set(),
  tools: new Set(),
  models: new Set(),
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
    models: () => hookLangfuse(lane),
  }
  for (const [kind, hook] of Object.entries(hooks))
    try {
      await hook()
      recorded.push(kind)
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
function hookPg(lane) {
  const { Client } = lane("pg")
  const query = Client.prototype.query
  Client.prototype.query = function (config, ...rest) {
    const text = typeof config === "string" ? config : config?.text
    if (typeof text === "string") noteTables(text)
    return query.call(this, config, ...rest)
  }
}

const identifier = String.raw`"(?:[^"]|"")+"|[A-Za-z_][\w$]*`
const tableName = new RegExp(
  String.raw`\b(insert\s+into|update|delete\s+from|from|join)\s+(?:(?:only|if\s+(?:not\s+)?exists)\s+)*(${identifier})(?:\s*\.\s*(${identifier}))?(\s*\()?`,
  "gi",
)
// Words that can follow `from`, `join` or `update` and are not a table:
// `do update set`, `for update skip locked`, `from lateral (...)`.
const notTables = new Set(["set", "skip", "nowait", "of", "lateral", "select"])

// Adds the tables that a statement names. A name after `from` or `join`
// is a read, and a name after `insert into`, `update` or `delete from` is a
// write.
// A name after `from` or `join` and before `(` is a function, not a table.
export function noteTables(text, into = edges) {
  const body = text.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "")
  if (/^(?:create|alter|drop|truncate|grant|revoke|comment|do)\b/i.test(body))
    return
  for (const [, keyword, first, second, call] of text.matchAll(tableName)) {
    const read = /^(from|join)$/i.test(keyword)
    if (read && call) continue
    const table = normalizeTable(first, second)
    if (table) (read ? into.read : into.write).add(table)
  }
}

// `"public"."users"` and `users` give `users`; another schema stays.
// Unquoted names fold to lower case, as in Postgres.
function normalizeTable(first, second) {
  const part = (name) =>
    name.startsWith('"')
      ? name.slice(1, -1).replaceAll('""', '"')
      : name.toLowerCase()
  const parts =
    second === undefined ? [part(first)] : [part(first), part(second)]
  if (parts.length === 2 && parts[0] === "public") parts.shift()
  if (parts.length === 1 && notTables.has(parts[0])) return undefined
  const table = parts.join(".")
  return table.length > 128 ? undefined : table
}

// HTTP route patterns of Hono apps (backend, codesearch): each route handler
// that runs records `<METHOD> <pattern>`. Middleware (method ALL, a pattern
// that ends in `*`) is not recorded.
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
            edges.routes.add(pattern)
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

// Model calls: the names of Langfuse generations (withLangfuseGeneration in
// the backend). A generation is a span that becomes a LangfuseGeneration, so
// a tracer wrapper remembers each span name, and the generation records it.
// The wrapper forwards each call to the provider that Langfuse would use
// without it: the global OpenTelemetry provider at the time of the call (a
// test can replace it), or a provider that was set before the hook.
async function hookLangfuse(lane) {
  const langfuse = await esm(lane, "@langfuse/tracing", "dist/index.mjs")
  const { trace } = createRequire(
    join(packageDir(lane, "@langfuse/tracing"), "package.json"),
  )("@opentelemetry/api")
  const before = langfuse.getLangfuseTracerProvider()
  const set = before !== trace.getTracerProvider() ? before : undefined
  const current = () => set ?? trace.getTracerProvider()
  const names = new WeakMap()
  const forward = (target, overrides) =>
    new Proxy(target, {
      get(object, property) {
        if (Object.hasOwn(overrides, property)) return overrides[property]
        const value = Reflect.get(object, property)
        return typeof value === "function" ? value.bind(object) : value
      },
    })
  const provider = {
    getTracer(...args) {
      const tracer = current().getTracer(...args)
      return forward(tracer, {
        startActiveSpan(name, ...rest) {
          const fn = rest.pop()
          return tracer.startActiveSpan(name, ...rest, (span) => {
            names.set(span, name)
            return fn(span)
          })
        },
      })
    },
  }
  langfuse.setLangfuseTracerProvider(
    new Proxy(provider, {
      get(object, property) {
        if (property === "getTracer") return object.getTracer
        const target = current()
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    }),
  )
  const update = langfuse.LangfuseGeneration.prototype.update
  langfuse.LangfuseGeneration.prototype.update = function (...args) {
    const name = names.get(this.otelSpan)
    if (name) edges.models.add(name)
    return update.apply(this, args)
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
