// Shared code of the `apis` skill: it finds the HTTP operations that a code
// root of a source repository defines. Two kinds of evidence:
//
//   - OpenAPI and Swagger files (JSON, and a small reader for YAML), and
//   - route registrations that ast-grep rules find (Express style, Hono
//     `createRoute`, FastAPI and Flask decorators, Spring annotations, Go,
//     axum, Laravel) and file-based routes (Next.js and SvelteKit).
//
// The source repository is hostile. The code reads only tracked files at HEAD
// (never a symbolic link), parses text with no regular expression that comes
// from the repository, caps each list, and returns only text that has passed
// `plainText` or `normalizePath`.

import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import {
  readTracked,
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]
const METHOD_SET = new Set(HTTP_METHODS)

export const MAX_SPECS = 20
export const MAX_SPEC_OPERATIONS = 500
export const MAX_ROUTES = 1000
const MAX_SPEC_LINES = 200_000
const AST_GREP_TIMEOUT_MS = 90_000
const AST_GREP_MAX_BUFFER = 32 * 1024 * 1024

/** Folders that never hold the API of a root: dependencies, build output, tests, fixtures. */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  "target",
  "test",
  "tests",
  "__tests__",
  "testdata",
  "fixtures",
  "__fixtures__",
  "examples",
  "example",
])

const TEST_FILE = /(?:\.(?:test|spec)\.[^/]+|_test\.(?:go|py|rb))$/

/**
 * A text from the repository or the model that is safe in a Markdown line
 * and in a YAML value, or null. A text has one line (a line break is refused), at most `max` characters, and starts
 * with a letter or a digit. It has no control or direction character, no
 * backtick, angle bracket, square bracket, pipe, or backslash, and no URL.
 */
export function plainText(text, max) {
  if (typeof text !== "string") return null
  const clean = text.trim()
  if (clean.length === 0 || clean.length > max) return null
  if (!/^[\p{L}\p{N}]/u.test(clean) || /^\d+[.)]\s/.test(clean)) return null
  if (
    // oxlint-disable-next-line no-control-regex -- the check refuses control and direction characters
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff`<>[\]|\\]/.test(
      clean,
    ) ||
    /:\/\/|\bwww\./i.test(clean)
  )
    return null
  return clean
}

/** `plainText` that shortens a long text at a word end instead of refusing it. */
export function shortText(text, max) {
  if (typeof text !== "string") return null
  const clean = text.replace(/\s+/g, " ").trim()
  const cut =
    clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean
  return plainText(cut, max)
}

const OPERATION_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%{}/-]*$/

/**
 * The OpenAPI form of a route path: `:id`, `<int:id>`, `{id:regex}`, `{id?}`,
 * and `[id]` become `{id}`; no trailing slash; no query. Null for a path that
 * is not a plain path (a template with `${`, `..`, a character that
 * the script does not write, more than 200 characters).
 */
export function normalizePath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > 400)
    return null
  const segments = (raw.split(/[?#]/)[0] ?? "").split("/").slice(1)
  const out = []
  for (const segment of segments) {
    if (segment === "") continue
    const match =
      /^:([A-Za-z_]\w*)[?*+]?(?:\(.*\))?$/.exec(segment) ??
      /^<(?:\w+(?:\([^)]*\))?:)?([A-Za-z_]\w*)>$/.exec(segment) ??
      /^\{([A-Za-z_][\w-]*)(?::.*|\?)?\}$/.exec(segment) ??
      /^\[(?:\.\.\.)?([A-Za-z_]\w*)\]$/.exec(segment)
    out.push(match ? `{${match[1]}}` : segment)
  }
  const path = `/${out.join("/")}`
  if (path.length > 200 || path.includes("..") || !OPERATION_PATH.test(path))
    return null
  return path
}

export const operationKey = (method, path) => `${method} ${path}`

// --- OpenAPI files ---------------------------------------------------------

const SPEC_NAME = /(?:openapi|swagger)[^/]*\.(?:json|ya?ml)$/i

function unquote(text) {
  const value = text.trim()
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote))
    return value.slice(1, -1)
  return value
}

/** A longer YAML line is not a key line of a specification. */
const MAX_YAML_LINE = 4096

/**
 * `key` of a YAML mapping line `key: value`, with the value text; null when
 * the line has another form. It reads the line from left to right with no
 * regular expression that can backtrack, so the cost is linear.
 */
export function yamlEntry(line) {
  if (line.length > MAX_YAML_LINE) return null
  const rest = line.trimStart()
  const indent = line.length - rest.length
  let key
  let after
  const quote = rest[0]
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1)
    if (close === -1) return null
    key = rest.slice(1, close)
    after = rest.slice(close + 1).trimStart()
    if (after[0] !== ":") return null
    after = after.slice(1)
  } else {
    if (rest === "" || /[\s#'"-]/.test(rest[0])) return null
    const end = rest.search(/[:#]/)
    if (end === -1 || rest[end] !== ":") return null
    key = rest.slice(0, end).trimEnd()
    after = rest.slice(end + 1)
  }
  if (after !== "" && !/^\s/.test(after)) return null
  const comment = after.search(/\s#/)
  return {
    indent,
    key,
    value: (comment === -1 ? after : after.slice(0, comment)).trim(),
  }
}

/**
 * A small reader for the OpenAPI and Swagger subset of YAML: the top-level
 * `openapi`, `swagger`, `info.title`, and `paths` keys. It reads indentation
 * and keys only, so it does not run YAML anchors, tags, or code.
 */
function readYamlSpec(text) {
  const lines = text.split("\n")
  if (lines.length > MAX_SPEC_LINES) return { skip: "The file is too long" }
  let version = null
  let title = null
  let pathsAt = -1
  let inInfo = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line) && !line.startsWith("#")) {
      inInfo = false
      const entry = yamlEntry(line)
      if (!entry) continue
      if (entry.key === "openapi" || entry.key === "swagger")
        version = unquote(entry.value)
      else if (entry.key === "info") inInfo = true
      else if (entry.key === "paths") pathsAt = i
    } else if (inInfo && title === null) {
      const entry = yamlEntry(line)
      if (entry && entry.key === "title") title = unquote(entry.value)
    }
  }
  if (!version) return { skip: "The file has no openapi or swagger key" }
  if (pathsAt === -1) return { skip: "The file has no paths key" }
  const operations = []
  let pathIndent = -1
  let methodIndent = -1
  let current = null
  let method = null
  let skipRefs = 0
  for (let i = pathsAt + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "" || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break
    const entry = yamlEntry(line)
    if (!entry) continue
    if (pathIndent === -1) pathIndent = entry.indent
    if (entry.indent === pathIndent) {
      current = entry.key.startsWith("/") ? entry.key : null
      method = null
      methodIndent = -1
      if (current && entry.value.startsWith("{") && /\$ref/.test(entry.value))
        skipRefs++
      continue
    }
    if (!current || entry.indent < pathIndent) continue
    if (methodIndent === -1) methodIndent = entry.indent
    if (entry.indent === methodIndent) {
      if (entry.key === "$ref") skipRefs++
      method = METHOD_SET.has(entry.key.toUpperCase())
        ? entry.key.toUpperCase()
        : null
      if (method) operations.push({ path: current, method })
    } else if (method && entry.indent > methodIndent) {
      const last = operations.at(-1)
      if (!last || last.method !== method || last.path !== current) continue
      if (entry.key === "operationId" && last.operationId === undefined)
        last.operationId = unquote(entry.value)
      else if (entry.key === "summary" && last.summary === undefined)
        last.summary = unquote(entry.value)
    }
  }
  return { version, title, operations, skipRefs }
}

function readJsonSpec(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { skip: "The file is not valid JSON" }
  }
  const version =
    typeof json?.openapi === "string"
      ? json.openapi
      : typeof json?.swagger === "string"
        ? json.swagger
        : null
  if (!version) return { skip: "The file has no openapi or swagger key" }
  if (!json.paths || typeof json.paths !== "object")
    return { skip: "The file has no paths key" }
  const operations = []
  let skipRefs = 0
  for (const [path, item] of Object.entries(json.paths)) {
    if (!path.startsWith("/") || !item || typeof item !== "object") continue
    if (typeof item.$ref === "string") skipRefs++
    for (const [method, operation] of Object.entries(item)) {
      if (!METHOD_SET.has(method.toUpperCase())) continue
      operations.push({
        path,
        method: method.toUpperCase(),
        operationId:
          typeof operation?.operationId === "string"
            ? operation.operationId
            : undefined,
        summary:
          typeof operation?.summary === "string"
            ? operation.summary
            : undefined,
      })
    }
  }
  return {
    version,
    title: typeof json.info?.title === "string" ? json.info.title : null,
    operations,
    skipRefs,
  }
}

/** The OpenAPI files of the root, each with its operations. */
function discoverSpecs(source, files, skipped) {
  const specs = []
  const candidates = files.filter((file) => SPEC_NAME.test(file)).sort()
  for (const file of candidates) {
    if (specs.length >= MAX_SPECS) {
      skipped.push({
        path: null,
        reason: `The script read only the first ${MAX_SPECS} specification files`,
      })
      break
    }
    const text = readTracked(source, file)
    if (!text) {
      skipped.push({
        path: file,
        reason: "The file is empty, larger than 1 MiB, or not readable",
      })
      continue
    }
    const read = /\.json$/i.test(file) ? readJsonSpec(text) : readYamlSpec(text)
    if (read.skip) {
      skipped.push({ path: file, reason: read.skip })
      continue
    }
    const operations = []
    const seen = new Set()
    let refused = 0
    for (const operation of read.operations) {
      const path = normalizePath(operation.path)
      if (!path) {
        refused++
        continue
      }
      const key = operationKey(operation.method, path)
      if (seen.has(key)) continue
      seen.add(key)
      if (operations.length >= MAX_SPEC_OPERATIONS) {
        refused++
        continue
      }
      operations.push({
        method: operation.method,
        path,
        ...(shortText(operation.operationId, 80)
          ? { operationId: shortText(operation.operationId, 80) }
          : {}),
        ...(shortText(operation.summary, 120)
          ? { summary: shortText(operation.summary, 120) }
          : {}),
      })
    }
    if (refused > 0)
      skipped.push({
        path: file,
        reason: `${refused} operations were not listed: a path the script does not write, or more than ${MAX_SPEC_OPERATIONS}`,
      })
    if (read.skipRefs > 0)
      skipped.push({
        path: file,
        reason: `${read.skipRefs} path items are references to other files and are not read`,
      })
    specs.push({
      path: file,
      version: shortText(read.version, 20),
      title: shortText(read.title, 100),
      operations,
    })
  }
  return specs
}

// --- ast-grep route rules --------------------------------------------------

const LOWER_METHODS = "get|post|put|patch|delete|head|options"
const UPPER_METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS"
const JS_LANGUAGES = ["typescript", "tsx", "javascript"]

/** Each rule has a unique id. `framework` is the label in the result. */
export const ROUTE_RULES = [
  ...JS_LANGUAGES.map((language) => ({
    id: `express-${language}`,
    framework: "express-style",
    language,
    rule: { pattern: "$APP.$METHOD($PATH, $$$REST)" },
    constraints: {
      METHOD: { regex: `^(${LOWER_METHODS})$` },
      PATH: { regex: "^[\"'`]/" },
    },
  })),
  ...JS_LANGUAGES.map((language) => ({
    id: `createroute-${language}`,
    framework: "zod-openapi",
    language,
    rule: { pattern: "createRoute($OBJ)" },
    constraints: { OBJ: { kind: "object" } },
  })),
  {
    id: "python-decorator",
    framework: "python-decorator",
    language: "python",
    rule: {
      any: [
        { pattern: "$APP.$METHOD($PATH, $$$REST)" },
        { pattern: "$APP.$METHOD($PATH)" },
      ],
      inside: { kind: "decorator" },
    },
    constraints: {
      METHOD: { regex: `^(${LOWER_METHODS}|route)$` },
      PATH: { regex: "^[\"']/" },
    },
  },
  {
    id: "spring",
    framework: "spring",
    language: "java",
    rule: {
      kind: "annotation",
      regex: "^@(Get|Post|Put|Patch|Delete|Request)Mapping",
    },
  },
  {
    id: "go",
    framework: "go",
    language: "go",
    rule: { pattern: "$R.$METHOD($PATH, $$$REST)" },
    constraints: {
      METHOD: {
        regex: `^(${UPPER_METHODS}|Get|Post|Put|Patch|Delete|Head|Options|Handle|HandleFunc)$`,
      },
      PATH: { regex: '^"(?:[A-Z]+ )?/' },
    },
  },
  {
    id: "axum",
    framework: "axum",
    language: "rust",
    rule: { pattern: "$R.route($PATH, $$$REST)" },
    constraints: { PATH: { regex: '^"/' } },
  },
  {
    id: "laravel",
    framework: "laravel",
    language: "php",
    rule: { pattern: "Route::$METHOD($PATH, $$$REST)" },
    constraints: {
      METHOD: { regex: `^(${LOWER_METHODS})$` },
      PATH: { regex: "^[\"']/" },
    },
  },
]

/** A string literal's text, or null (a template literal with `${`, an escape, no quotes). */
function stringLiteral(text) {
  const quote = text?.[0]
  if (!quote || !`"'\``.includes(quote) || text.at(-1) !== quote) return null
  const inner = text.slice(1, -1)
  if (inner.includes("\\") || inner.includes("${") || inner.includes(quote))
    return null
  return inner
}

/** The operations ({ method, path }) of one ast-grep match, or []. */
function operationsOfMatch(rule, match) {
  const single = match.metaVariables?.single ?? {}
  const text = String(match.text ?? "").slice(0, 4096)
  const pathOf = (raw) => normalizePath(stringLiteral(raw) ?? "")
  switch (rule.framework) {
    case "express-style": {
      const method = single.METHOD?.text?.toUpperCase()
      const path = pathOf(single.PATH?.text)
      return METHOD_SET.has(method) && path ? [{ method, path }] : []
    }
    case "zod-openapi": {
      const body = String(single.OBJ?.text ?? "").slice(0, 4096)
      const method = /\bmethod\s*:\s*["'](\w+)["']/
        .exec(body)?.[1]
        ?.toUpperCase()
      const path = pathOf(/\bpath\s*:\s*(["'][^"']*["'])/.exec(body)?.[1] ?? "")
      return METHOD_SET.has(method) && path ? [{ method, path }] : []
    }
    case "python-decorator": {
      const verb = single.METHOD?.text?.toLowerCase()
      const path = pathOf(single.PATH?.text)
      if (!path) return []
      if (verb !== "route") return [{ method: verb.toUpperCase(), path }]
      const methods =
        /\bmethods\s*=\s*[[(]([^\])]*)[\])]/.exec(text)?.[1] ?? "'GET'"
      return [...methods.matchAll(/["'](\w+)["']/g)]
        .map((m) => m[1].toUpperCase())
        .filter((method) => METHOD_SET.has(method))
        .map((method) => ({ method, path }))
    }
    case "spring": {
      const annotation = /^@(Get|Post|Put|Patch|Delete|Request)Mapping/.exec(
        text,
      )?.[1]
      const literal =
        /(?:\(\s*(?:(?:value|path)\s*=\s*)?|\b(?:value|path)\s*=\s*)(["'][^"']*["'])/.exec(
          text,
        )?.[1]
      const path = pathOf(literal)
      if (!annotation || !path) return []
      if (annotation !== "Request")
        return [{ method: annotation.toUpperCase(), path }]
      // A class-level @RequestMapping("/prefix") has no method: it is a prefix, not an operation.
      const method = /RequestMethod\.(\w+)/.exec(text)?.[1]?.toUpperCase()
      return METHOD_SET.has(method) ? [{ method, path }] : []
    }
    case "go": {
      const verb = single.METHOD?.text
      const literal = stringLiteral(single.PATH?.text)
      if (!literal) return []
      const withMethod = /^([A-Z]+) (\/.*)$/.exec(literal)
      const path = normalizePath(withMethod ? withMethod[2] : literal)
      if (!path) return []
      if (withMethod)
        return METHOD_SET.has(withMethod[1])
          ? [{ method: withMethod[1], path }]
          : []
      if (verb === "Handle" || verb === "HandleFunc")
        return [{ method: "ANY", path }]
      const method = verb.toUpperCase()
      return METHOD_SET.has(method) ? [{ method, path }] : []
    }
    case "axum": {
      const path = pathOf(single.PATH?.text)
      if (!path) return []
      const rest = (match.metaVariables?.multi?.REST ?? [])
        .map((node) => node.text)
        .join(" ")
      const methods = [
        ...rest.matchAll(new RegExp(`\\b(${LOWER_METHODS})\\s*\\(`, "g")),
      ].map((m) => m[1].toUpperCase())
      return [...new Set(methods)].map((method) => ({ method, path }))
    }
    case "laravel": {
      const method = single.METHOD?.text?.toUpperCase()
      const path = pathOf(single.PATH?.text)
      return METHOD_SET.has(method) && path ? [{ method, path }] : []
    }
    default:
      return []
  }
}

/** The ast-grep route matches below `target`: [{ rule, match }]. Null and a reason when ast-grep fails. */
function runRouteRules(target) {
  const cwd = mkdtempSync(join(tmpdir(), "apis-sg-"))
  try {
    // Run in an empty folder with only inline rules, so an sgconfig.yml of the
    // repository (it can load a language library) is never read. Symbolic
    // links are not followed.
    const rules = ROUTE_RULES.map(({ framework: _f, ...rule }) =>
      JSON.stringify(rule),
    ).join("\n---\n")
    const result = spawnSync(
      "ast-grep",
      [
        "scan",
        "--inline-rules",
        rules,
        "--json=stream",
        "--globs",
        "!**/{node_modules,vendor,third_party,dist,build,target,test,tests,__tests__,testdata,fixtures,__fixtures__,examples}/**",
        "--globs",
        "!**/*.{test,spec}.*",
        "--globs",
        "!**/*_test.*",
        "--globs",
        "!.git",
        "--",
        target,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: AST_GREP_TIMEOUT_MS,
        maxBuffer: AST_GREP_MAX_BUFFER,
        env: { PATH: process.env.PATH ?? "", HOME: cwd },
      },
    )
    if (result.error)
      return {
        matches: null,
        reason:
          result.error.code === "ENOENT"
            ? "ast-grep is not installed"
            : result.error.code === "ETIMEDOUT"
              ? "ast-grep ran longer than the time limit"
              : "ast-grep stopped: its output is too large",
      }
    if (result.status !== 0)
      return {
        matches: null,
        reason: `ast-grep exited with code ${result.status}`,
      }
    const byId = new Map(ROUTE_RULES.map((rule) => [rule.id, rule]))
    const matches = []
    for (const line of result.stdout.split("\n")) {
      if (!line) continue
      try {
        const match = JSON.parse(line)
        const rule = byId.get(match.ruleId)
        if (rule && typeof match.file === "string")
          matches.push({ rule, match })
      } catch {}
    }
    return { matches }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

// --- file-based routes -----------------------------------------------------

const FILE_ROUTE_EXPORT =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g

/** Next.js (`app/**\/route.ts`) and SvelteKit (`routes/**\/+server.ts`): the path comes from the folders. */
function fileRoute(file) {
  const next = /^(?:.*\/)?app\/((?:.*\/)?)route\.(?:ts|tsx|js|jsx|mjs)$/.exec(
    file,
  )
  const svelte = /^(?:.*\/)?routes\/((?:.*\/)?)\+server\.(?:ts|js)$/.exec(file)
  const folders = next?.[1] ?? svelte?.[1]
  if (folders === undefined) return null
  const segments = folders
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"))
  return {
    framework: next ? "next-app-router" : "sveltekit",
    path: normalizePath(`/${segments.join("/")}`),
  }
}

// --- the result ------------------------------------------------------------

function insideRoot(file, codeRoot) {
  return codeRoot === "." || file.startsWith(`${codeRoot}/`)
}

function ignored(file) {
  const segments = file.split("/")
  return (
    segments.some((s) => s.startsWith(".") || IGNORED_SEGMENTS.has(s)) ||
    TEST_FILE.test(file)
  )
}

/**
 * The operations that the script found in the root `codeRoot` ("." for the
 * repository root). `otherRoots` are the paths of other code roots; a file
 * below one of them that is nested in this root belongs to that root.
 *
 * Result: { root, specs, routes, skipped }. `routes` entries have `method`
 * (`ANY` when the route has no method), `path`, `file`, `line`, `framework`.
 */
export function discoverApis(source, codeRoot, otherRoots = []) {
  const skipped = []
  if (codeRoot !== "." && !safePath(codeRoot))
    return {
      root: codeRoot,
      specs: [],
      routes: [],
      skipped: [{ path: null, reason: "The root path is not safe" }],
    }
  const nested = otherRoots.filter(
    (other) =>
      other !== codeRoot &&
      safePath(other) &&
      (codeRoot === "." ? other !== "." : other.startsWith(`${codeRoot}/`)),
  )
  const files = trackedFiles(source).filter(
    (file) =>
      insideRoot(file, codeRoot) &&
      !ignored(file) &&
      !nested.some((other) => file === other || file.startsWith(`${other}/`)),
  )
  const tracked = new Set(files)
  const specs = discoverSpecs(source, files, skipped)

  const routes = []
  const seen = new Set()
  const add = (route) => {
    const key = `${route.method} ${route.path} ${route.file}`
    if (seen.has(key)) return
    seen.add(key)
    routes.push(route)
  }

  // ast-grep reads the working tree. Refuse a root that is a symbolic link
  // or that leaves the checkout.
  const checkout = realpathSync(source)
  const target = codeRoot === "." ? source : join(source, codeRoot)
  let resolved = null
  try {
    resolved = realpathSync(target)
  } catch {}
  if (
    resolved &&
    (resolved === checkout || resolved.startsWith(`${checkout}/`)) &&
    relative(checkout, resolved) === (codeRoot === "." ? "" : codeRoot)
  ) {
    const found = runRouteRules(resolved)
    if (found.matches === null)
      skipped.push({ path: null, reason: found.reason })
    else
      for (const { rule, match } of found.matches) {
        const file = relative(checkout, String(match.file))
        if (!tracked.has(file)) continue
        for (const operation of operationsOfMatch(rule, match))
          add({
            ...operation,
            file,
            line: (match.range?.start?.line ?? 0) + 1,
            framework: rule.framework,
          })
      }
  } else {
    skipped.push({
      path: null,
      reason: "The root folder is a symbolic link or is not in the checkout",
    })
  }

  for (const file of files) {
    const route = fileRoute(file)
    if (!route) continue
    if (!route.path) {
      skipped.push({ path: file, reason: "The route path is not written" })
      continue
    }
    const text = readTracked(source, file)
    for (const m of text.matchAll(FILE_ROUTE_EXPORT))
      add({
        method: m[1],
        path: route.path,
        file,
        line: text.slice(0, m.index).split("\n").length,
        framework: route.framework,
      })
  }

  routes.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
  )
  if (routes.length > MAX_ROUTES)
    skipped.push({
      path: null,
      reason: `The script listed only the first ${MAX_ROUTES} routes`,
    })
  return {
    root: codeRoot,
    specs,
    routes: routes.slice(0, MAX_ROUTES),
    skipped,
  }
}

/** Candidate operations by key: the script evidence that the writer accepts. */
export function candidateOperations(result) {
  const found = new Map()
  for (const spec of result.specs)
    for (const operation of spec.operations) {
      const key = operationKey(operation.method, operation.path)
      if (!found.has(key))
        found.set(key, { ...operation, evidence: spec.path, from: "spec" })
    }
  for (const route of result.routes) {
    const key = operationKey(route.method, route.path)
    if (!found.has(key))
      found.set(key, {
        method: route.method,
        path: route.path,
        evidence: route.file,
        from: "route",
      })
  }
  return found
}
