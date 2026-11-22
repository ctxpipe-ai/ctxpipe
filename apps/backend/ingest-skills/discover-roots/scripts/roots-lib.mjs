// Find the code roots of a source checkout from its workspace manifests.
// The host plans the root steps from this result. A model looks only at the
// `ambiguous` entries, and it can choose only from their `candidates`
// (apps/backend/src/domain/ingestion/discovered-roots.ts checks that).
//
// Result: { roots: [{ path, manifests, evidence }],
//           ambiguous: [{ manifest, reason, candidates: [{ path, manifests }] }],
//           skipped: [{ manifest, reason }] }
// `path` is "." for the repository root. `evidence` names the files that make
// the folder a root: the workspace manifests that list it (also a nested Cargo
// workspace), the `Cargo.toml` that names it as a path dependency of a
// workspace member, or the Go file of a `main` package. It is "." for the
// single-root fallback. An ambiguous entry always has a candidate; an entry
// with none is in `skipped`.
//
// The source repository is hostile. The script never builds a regular
// expression from its text, and it caps the length and the count of entries.

import { execFileSync } from "node:child_process"
import { posix } from "node:path"

/** Files that make a folder a package. */
const PACKAGE_MARKERS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "deno.json",
  "deno.jsonc",
]

const MAX_ENTRY_LENGTH = 200
const MAX_ENTRIES = 500
const MAX_BRACE_ALTERNATIVES = 64
const MAX_SEGMENTS = 32
const MAX_DOUBLE_STARS = 4
/** Longest glob segment, and longest path name segment that the matcher compares. */
const MAX_GLOB_SEGMENT = 128
const MAX_NAME_SEGMENT = 255
/** Folders deeper than this have no match, and the script skips them. */
export const MAX_DEPTH = 64
/**
 * The host refuses a result larger than 1 MiB (`MAX_DISCOVERY_BYTES` in
 * apps/backend/src/domain/ingestion/ingest-shard-ops.ts). The script keeps
 * its result below this size, with room for its own skipped entry.
 */
const MAX_RESULT_BYTES = 1024 * 1024 - 64 * 1024
/**
 * Match steps for one script run, shared by each glob. A step is one cell of
 * the segment table or one character compare inside `matchSegment`.
 */
const MAX_MATCH_STEPS = 2_000_000
let matchSteps = 0

/** Steps the shared match budget has used so far. */
export const matchStepsUsed = () => matchSteps

/** True while the shared match budget has steps left. */
export const matchBudgetLeft = () => matchSteps <= MAX_MATCH_STEPS

/**
 * True when a path or a name is safe to write into a Markdown line or a YAML
 * value: no control character (C0 or C1), no newline or line separator, no
 * invisible direction character, no backtick, no `..`, at most 300
 * characters. apps/backend/src/domain/ingestion/discovered-roots.ts has the
 * same rule.
 */
export function safePath(text) {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= 300 &&
    // oxlint-disable-next-line no-control-regex -- the check refuses control and direction characters
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069`]/.test(
      text,
    ) &&
    !text.includes("..")
  )
}

/** Folder names that never hold a code root. */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "testdata",
  "fixtures",
  "__fixtures__",
])

function ignoredFolder(dir) {
  if (dir === ".") return false
  return dir
    .split("/")
    .some((segment) => segment.startsWith(".") || IGNORED_SEGMENTS.has(segment))
}

/** Tracked files of a checkout at HEAD. */
export function trackedFiles(source) {
  return execFileSync("git", ["-C", source, "ls-files", "-z"], {
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
}

/** Text of a tracked file at HEAD; "" when it is missing or larger than 1 MiB (a manifest is small). */
export function readTracked(source, path) {
  try {
    return execFileSync("git", ["-C", source, "show", `HEAD:${path}`], {
      maxBuffer: 1024 * 1024,
    }).toString("utf8")
  } catch {
    return ""
  }
}

function cleanEntry(value) {
  let entry = String(value).trim()
  while (entry.startsWith("./")) entry = entry.slice(2)
  while (entry.endsWith("/")) entry = entry.slice(0, -1)
  return entry === "" ? "." : entry
}

/**
 * A matcher for a glob from repository text: { matches(path) } or
 * { skip: reason }. It never builds a regular expression from the glob. It
 * matches one path segment at a time, so the time is at most the product of
 * the glob length and the path length. `*` and `?` stay in one segment; a
 * `**` segment matches zero or more segments.
 *
 * Workspace manifests (pnpm, npm, Cargo, uv, Deno) expand `{a,b}` and match
 * the full folder path. CODEOWNERS follows gitignore rules, so `codeowners`
 * changes three things: braces are literal; a pattern with no slash before
 * its end matches at each depth; and a pattern that matches a folder also
 * covers each folder below it.
 */
export function globMatcher(glob, { codeowners = false } = {}) {
  if (glob.length > MAX_ENTRY_LENGTH)
    return { skip: `it is longer than ${MAX_ENTRY_LENGTH} characters` }
  const segmentsOfGlob = glob.split("/").filter(Boolean)
  if (segmentsOfGlob.length > MAX_SEGMENTS)
    return { skip: `it has more than ${MAX_SEGMENTS} segments` }
  if (segmentsOfGlob.filter((s) => s === "**").length > MAX_DOUBLE_STARS)
    return { skip: `it has more than ${MAX_DOUBLE_STARS} \`**\` segments` }
  const alternatives = codeowners ? [glob] : expandBraces(glob)
  if (!alternatives) return { skip: "it has an unbalanced brace" }
  if (alternatives.length > MAX_BRACE_ALTERNATIVES)
    return { skip: `it expands to more than ${MAX_BRACE_ALTERNATIVES} globs` }
  // Braces can make a `**` segment, so count after the expansion.
  if (
    alternatives.some(
      (text) =>
        text.split("/").filter((s) => s === "**").length > MAX_DOUBLE_STARS,
    )
  )
    return { skip: `it has more than ${MAX_DOUBLE_STARS} \`**\` segments` }
  if (
    alternatives.some((text) =>
      text.split("/").some((s) => s.length > MAX_GLOB_SEGMENT),
    )
  )
    return {
      skip: `it has a segment longer than ${MAX_GLOB_SEGMENT} characters`,
    }
  const patterns = alternatives.map((text) => {
    let segments = text.split("/")
    if (codeowners) {
      const trimmed = text.replace(/^\/+/, "").replace(/\/+$/, "")
      // gitignore: a slash at the start or in the middle anchors the pattern.
      const anchored = text.startsWith("/") || trimmed.includes("/")
      segments = trimmed === "" ? [] : trimmed.split("/")
      if (!anchored) segments.unshift("**")
      segments.push("**")
    }
    return segments.filter((s, i) => !(s === "**" && segments[i - 1] === "**"))
  })
  return {
    matches: (path) => {
      const parts = path === "." ? [] : path.split("/")
      if (parts.length > MAX_DEPTH) return false
      return patterns.some((pattern) => matchSegments(pattern, parts))
    },
  }
}

/** The globs of `{a,b}` alternatives, or null for an unbalanced brace. */
function expandBraces(glob) {
  const open = glob.indexOf("{")
  if (open === -1) return glob.includes("}") ? null : [glob]
  if (glob.slice(0, open).includes("}")) return null
  let depth = 0
  let close = -1
  const cuts = []
  for (let i = open; i < glob.length && close === -1; i++) {
    if (glob[i] === "{") depth++
    else if (glob[i] === "}" && --depth === 0) close = i
    else if (glob[i] === "," && depth === 1) cuts.push(i)
  }
  if (close === -1) return null
  const out = []
  let from = open + 1
  for (const cut of [...cuts, close]) {
    const rest = expandBraces(
      `${glob.slice(0, open)}${glob.slice(from, cut)}${glob.slice(close + 1)}`,
    )
    if (!rest) return null
    out.push(...rest)
    if (out.length > MAX_BRACE_ALTERNATIVES) return out
    from = cut + 1
  }
  return out
}

function matchSegments(pattern, parts) {
  const memo = new Map()
  const match = (p, s) => {
    if (p === pattern.length) return s === parts.length
    const key = p * (parts.length + 1) + s
    if (memo.has(key)) return memo.get(key)
    // The result of a run that is out of budget is not used: each caller checks.
    if (++matchSteps > MAX_MATCH_STEPS) return false
    const ok =
      pattern[p] === "**"
        ? match(p + 1, s) || (s < parts.length && match(p, s + 1))
        : s < parts.length &&
          matchSegment(pattern[p], parts[s]) &&
          match(p + 1, s + 1)
    memo.set(key, ok)
    return ok
  }
  return match(0, 0)
}

/**
 * One segment against `*` and `?`, with one backtrack point. Each loop turn
 * is a step of the shared budget. A name longer than MAX_NAME_SEGMENT has no
 * match, and so does a run that is out of budget (each caller checks).
 */
function matchSegment(glob, text) {
  if (text.length > MAX_NAME_SEGMENT) return false
  let g = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (++matchSteps > MAX_MATCH_STEPS) return false
    if (g < glob.length && (glob[g] === "?" || glob[g] === text[t])) {
      g++
      t++
    } else if (g < glob.length && glob[g] === "*") {
      star = g++
      mark = t
    } else if (star !== -1) {
      g = star + 1
      t = ++mark
    } else return false
  }
  while (glob[g] === "*") {
    if (++matchSteps > MAX_MATCH_STEPS) return false
    g++
  }
  return g === glob.length
}

const isGlob = (entry) => /[*?{[]/.test(entry)

/** The TOML lines of each `[table]`, keyed by table name. Enough for manifests. */
export function tomlTables(text) {
  const tables = new Map([["", []]])
  let current = ""
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd()
    // `[[bin]]` (an array of tables) starts a table too.
    const header = /^\s*\[\[?([^[\]]+)\]\]?\s*$/.exec(line)
    if (header) {
      current = header[1].trim()
      if (!tables.has(current)) tables.set(current, [])
      continue
    }
    tables.get(current).push(line)
  }
  return tables
}

/** Strings of a TOML array `key = [ ... ]` in one table. Line by line, with no regular expression over the file. */
export function tomlStringArray(tables, table, key) {
  const lines = tables.get(table) ?? []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith(key)) continue
    const rest = line.slice(key.length).trimStart()
    if (!rest.startsWith("=")) continue
    const value = rest.slice(1).trimStart()
    if (!value.startsWith("[")) return []
    const parts = [value.slice(1)]
    let closed = value.includes("]")
    while (!closed && ++i < lines.length) {
      parts.push(lines[i])
      closed = lines[i].includes("]")
    }
    const body = parts.join("\n")
    const end = body.indexOf("]")
    return [
      ...(end === -1 ? body : body.slice(0, end)).matchAll(
        /"([^"]*)"|'([^']*)'/g,
      ),
    ].map((m) => m[1] ?? m[2] ?? "")
  }
  return []
}

/** List items of a top-level YAML key, in block form. Null when the key is in another form. */
function yamlBlockList(text, key) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) =>
    new RegExp(`^${key}:\\s*(#.*)?$`).test(line),
  )
  if (start === -1) return null
  const items = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = /^\s+-\s+(['"]?)(.*?)\1\s*(#.*)?$/.exec(line)
    if (!item) break
    items.push(item[2])
  }
  return items
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((v) => typeof v === "string")
    : null
}

/** JSON with `//` and block comments and trailing commas (rush.json, deno.jsonc). */
function parseJsonc(text) {
  const out = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out.push(ch)
      if (ch === "\\") out.push(text[++i] ?? "")
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
      out.push(ch)
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out.push("\n")
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 1
    } else out.push(ch)
  }
  return parseJson(out.join("").replace(/,(\s*[}\]])/g, "$1"))
}

const NO_LIST = "The script found no package list in the file"

/**
 * The workspace manifests at the repository root, as
 * { manifest, markers, entries } or { manifest, unreadable }.
 * `entries` are folder paths or globs; a `!` entry excludes.
 */
function workspaceManifests(source, rootFiles) {
  const found = []
  const read = (path) => readTracked(source, path)
  const listed = (manifest, markers, entries, unreadable = NO_LIST) =>
    found.push(
      entries?.length
        ? { manifest, markers, entries }
        : { manifest, unreadable },
    )
  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"])
    if (rootFiles.has(name))
      listed(name, ["package.json"], yamlBlockList(read(name), "packages"))
  if (rootFiles.has("package.json")) {
    const json = parseJson(read("package.json"))
    const list =
      stringList(json?.workspaces) ?? stringList(json?.workspaces?.packages)
    if (list?.length)
      found.push({
        manifest: "package.json",
        markers: ["package.json"],
        entries: list,
      })
  }
  if (rootFiles.has("lerna.json"))
    listed(
      "lerna.json",
      ["package.json"],
      stringList(parseJson(read("lerna.json"))?.packages),
    )
  if (rootFiles.has("rush.json")) {
    const projects = parseJsonc(read("rush.json"))?.projects
    listed(
      "rush.json",
      ["package.json"],
      Array.isArray(projects)
        ? stringList(projects.map((p) => p?.projectFolder))
        : null,
      "The script found no project list in the file",
    )
  }
  for (const name of ["deno.json", "deno.jsonc"]) {
    if (!rootFiles.has(name)) continue
    const workspace = parseJsonc(read(name))?.workspace
    const members = stringList(workspace) ?? stringList(workspace?.members)
    // A deno.json with no workspace is one package, not a workspace manifest.
    if (members?.length)
      found.push({
        manifest: name,
        markers: ["deno.json", "deno.jsonc", "package.json"],
        entries: members,
      })
  }
  if (rootFiles.has("go.work")) {
    const entries = []
    let inBlock = false
    for (const raw of read("go.work").split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim()
      if (inBlock) {
        if (line.startsWith(")")) inBlock = false
        else if (line) entries.push(line)
      } else if (/^use\s*\($/.test(line)) inBlock = true
      else if (line.startsWith("use ")) entries.push(line.slice(4).trim())
    }
    listed(
      "go.work",
      ["go.mod"],
      entries,
      "The script found no use directive in the file",
    )
  }
  if (rootFiles.has("pyproject.toml")) {
    const tables = tomlTables(read("pyproject.toml"))
    const members = tomlStringArray(tables, "tool.uv.workspace", "members")
    const exclude = tomlStringArray(tables, "tool.uv.workspace", "exclude")
    if (members.length)
      found.push({
        manifest: "pyproject.toml",
        markers: ["pyproject.toml"],
        entries: [...members, ...exclude.map((e) => `!${e}`)],
      })
  }
  if (rootFiles.has("pom.xml")) {
    const modules = [
      ...read("pom.xml").matchAll(/<module>\s*([^<]+?)\s*<\/module>/g),
    ].map((m) => m[1])
    if (modules.length)
      found.push({ manifest: "pom.xml", markers: null, entries: modules })
  }
  for (const name of ["settings.gradle", "settings.gradle.kts"]) {
    if (!rootFiles.has(name)) continue
    const entries = []
    for (const call of read(name).matchAll(
      /^[ \t]*include\b[ \t]*\(?([^\n)]*)/gm,
    ))
      for (const arg of call[1].matchAll(/['"]([^'"]+)['"]/g))
        entries.push(arg[1].replace(/^:/, "").replaceAll(":", "/"))
    if (entries.length) found.push({ manifest: name, markers: null, entries })
  }
  return found
}

/**
 * Folder names that hold tests, examples, or generated code. A root that no
 * manifest lists, but that the script finds by a language rule (a nested
 * Cargo workspace or a Go `main` package), is not in such a folder. A name
 * like `test-utils` or `proc-macro-test` is a test folder too.
 */
const TEST_SEGMENTS = new Set([
  "test",
  "tests",
  "testing",
  "e2e",
  "example",
  "examples",
  "sample",
  "samples",
  "fuzz",
  "generated",
])

const inTestFolder = (dir) =>
  dir.split("/").some((segment) => {
    const words = segment.toLowerCase().split(/[-_]/)
    return (
      TEST_SEGMENTS.has(segment.toLowerCase()) ||
      (words.length > 1 &&
        ["test", "tests"].some((t) => words[0] === t || words.at(-1) === t))
    )
  })

/**
 * `parse` of the text of each tracked file at HEAD, keyed by path, with two
 * git calls for each 500 paths. Like `readTracked`, a file that is missing
 * or larger than 1 MiB is "". The script parses each chunk before it reads
 * the next chunk, so it holds the file text of one chunk (at most 500 MiB)
 * and only the parsed values of the other chunks.
 */
function readTrackedMany(source, paths, parse) {
  const empty = parse("")
  const out = new Map(paths.map((p) => [p, empty]))
  const list = paths.filter((p) => !p.includes("\n") && !p.includes("\r"))
  const git = (args, input) =>
    execFileSync("git", ["-C", source, ...args], {
      input,
      maxBuffer: 512 * 1024 * 1024 + 64 * 1024,
    })
  for (let from = 0; from < list.length; from += 500) {
    const chunk = list.slice(from, from + 500)
    const small = []
    const lines = git(
      ["cat-file", "--batch-check"],
      chunk.map((p) => `HEAD:${p}\n`).join(""),
    )
      .toString("utf8")
      .split("\n")
    chunk.forEach((path, i) => {
      const [oid, type, size] = lines[i].split(" ")
      if (type === "blob" && Number(size) <= 1024 * 1024)
        small.push({ path, oid, size: Number(size) })
    })
    if (small.length === 0) continue
    const buffer = git(
      ["cat-file", "--batch"],
      small.map((f) => `${f.oid}\n`).join(""),
    )
    let at = 0
    for (const { path, size } of small) {
      at = buffer.indexOf(10, at) + 1
      out.set(path, parse(buffer.toString("utf8", at, at + size)))
      at += size + 1
    }
  }
  return out
}

/** A folder path from `dir` and a relative path, or null when it leaves the repository. */
function joinFolder(dir, relative) {
  if (relative.startsWith("/") || relative.includes("\\")) return null
  const joined = posix.normalize(dir === "." ? relative : `${dir}/${relative}`)
  const path = joined.replace(/\/+$/, "") || "."
  return path === ".." || path.startsWith("../") ? null : path
}

const cargoManifest = (dir) =>
  dir === "." ? "Cargo.toml" : `${dir}/Cargo.toml`

/**
 * The Cargo workspaces: each tracked `Cargo.toml` with a `[workspace]` table,
 * as a workspace manifest whose entries are relative to the repository
 * root. A nested workspace is not in a test or example folder. A root
 * `Cargo.toml` with a `[package]` and no `[workspace]` is a workspace too,
 * with no entries, so that the script follows its path dependencies.
 */
function cargoWorkspaces(source, markersOf) {
  const dirs = [...markersOf.keys()]
    .filter((dir) => markersOf.get(dir).includes("Cargo.toml"))
    .filter((dir) => dir === "." || !inTestFolder(dir))
    .sort()
  const parsed = readTrackedMany(source, dirs.map(cargoManifest), (text) => {
    const tables = tomlTables(text)
    return {
      workspace: tables.has("workspace"),
      package: tables.has("package"),
      members: tomlStringArray(tables, "workspace", "members"),
      exclude: tomlStringArray(tables, "workspace", "exclude"),
    }
  })
  const found = []
  for (const dir of dirs) {
    const tables = parsed.get(cargoManifest(dir))
    const workspace = tables.workspace
    if (!workspace && !(dir === "." && tables.package)) continue
    const members = tables.members
    const entries = []
    for (const raw of members) {
      const path = joinFolder(dir, cleanEntry(raw))
      if (path) entries.push(path)
    }
    // Cargo excludes the folder and each folder below it. An exclude is a
    // path, not a glob.
    const excludes = tables.exclude
      .map((raw) => joinFolder(dir, cleanEntry(raw)))
      .filter(Boolean)
    for (const path of excludes) entries.push(`!${path}`, `!${path}/**`)
    found.push({
      manifest: cargoManifest(dir),
      markers: ["Cargo.toml"],
      dir,
      entries,
      excluded: (path) =>
        excludes.some((e) => path === e || path.startsWith(`${e}/`)),
      // With no `[workspace]`, the single-root fallback gives the root.
      rootPackage: workspace && tables.package,
      // As before, a root workspace with no `members` is not a workspace
      // manifest for the single-root fallback.
      rootLevel: dir === "." && members.length > 0,
    })
  }
  return found
}

const CARGO_DEPENDENCY_TABLES = new Set([
  "dependencies",
  "dev-dependencies",
  "dev_dependencies",
  "build-dependencies",
  "build_dependencies",
])

/** The `path` values of the dependency tables of a `Cargo.toml`, also `[workspace.dependencies]` and `[target.*.dependencies]`. Not `[patch]` or `[replace]`. */
function cargoPathDependencies(text) {
  const paths = []
  for (const [table, lines] of tomlTables(text)) {
    const parts = table.split(".").map((p) => p.trim())
    if (parts[0] === "patch" || parts[0] === "replace") continue
    if (!parts.some((p) => CARGO_DEPENDENCY_TABLES.has(p))) continue
    for (const line of lines)
      for (const m of line.matchAll(
        /(?:^|[\s{,.])path\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      ))
        paths.push(m[1] ?? m[2])
  }
  return paths
}

/**
 * The path dependencies that are members of a Cargo workspace, from the
 * `members` that its manifest lists, as [folder, manifest that names it].
 * Cargo makes
 * each path dependency of a member a member too, when it is in the
 * workspace folder and not excluded, so the script follows them from member
 * to member.
 */
function cargoPathMembers(source, markersOf, workspace, listed) {
  const out = []
  const seen = new Set(listed)
  let queue = [...new Set([workspace.dir, ...listed])]
  const inside = (dir) =>
    workspace.dir === "." || dir.startsWith(`${workspace.dir}/`)
  while (queue.length) {
    const dependencies = readTrackedMany(
      source,
      queue.map(cargoManifest),
      cargoPathDependencies,
    )
    const next = []
    for (const crate of queue) {
      // The workspace manifest is read for `[workspace.dependencies]`; it is
      // a member only when it has a `[package]`.
      for (const relative of dependencies.get(cargoManifest(crate))) {
        const dir = joinFolder(crate, cleanEntry(relative))
        if (
          !dir ||
          seen.has(dir) ||
          !inside(dir) ||
          !markersOf.get(dir)?.includes("Cargo.toml") ||
          workspace.excluded(dir)
        )
          continue
        seen.add(dir)
        out.push([dir, cargoManifest(crate)])
        next.push(dir)
      }
    }
    queue = next
  }
  return out
}

/**
 * A Go build constraint as a function of the set tags, or null when the
 * script cannot parse it. `//go:build` uses `||`, `&&`, `!` and
 * parentheses. A `// +build` line is a list of options with spaces between
 * them (or), each option a list of terms with commas between them (and).
 */
function goConstraint(line) {
  const body = line.replace(/^\/\/\s*(go:build|\+build)/, "").trim()
  if (/^\/\/\s*\+build/.test(line)) {
    const options = body.split(/\s+/).map((option) =>
      option.split(",").map((term) => {
        const not = term.startsWith("!")
        const tag = not ? term.slice(1) : term
        return (set) => set.has(tag) !== not
      }),
    )
    return (set) => options.some((terms) => terms.every((t) => t(set)))
  }
  const tokens = body.match(/\|\||&&|!|\(|\)|[\w.]+|\S/g) ?? []
  let at = 0
  const fail = () => {
    throw new Error("constraint")
  }
  const unary = () => {
    const token = tokens[at++]
    if (token === "!") {
      const inner = unary()
      return (set) => !inner(set)
    }
    if (token === "(") {
      const inner = or()
      if (tokens[at++] !== ")") fail()
      return inner
    }
    if (!token || !/^[\w.]+$/.test(token)) fail()
    return (set) => set.has(token)
  }
  const and = () => {
    let left = unary()
    while (tokens[at] === "&&") {
      at++
      const [l, r] = [left, unary()]
      left = (set) => l(set) && r(set)
    }
    return left
  }
  const or = () => {
    let left = and()
    while (tokens[at] === "||") {
      at++
      const [l, r] = [left, and()]
      left = (set) => l(set) || r(set)
    }
    return left
  }
  try {
    const expression = or()
    return at === tokens.length ? expression : null
  } catch {
    return null
  }
}

/**
 * True when no build can include a file with these constraint lines: each
 * set of tags without `ignore` makes the constraint false. The go tool reads
 * the `//go:build` line, and the `// +build` lines (all of them must be
 * true) only when there is no `//go:build` line. A constraint that the
 * script cannot parse, or that names more than 12 other tags, is not
 * ignored.
 */
function goIgnoredBuild(lines) {
  const goBuild = lines.find((l) => /^\/\/\s*go:build/.test(l))
  const constraints = (goBuild ? [goBuild] : lines).map(goConstraint)
  if (constraints.some((c) => c === null)) return false
  const tags = [
    ...new Set(
      (goBuild ? [goBuild] : lines)
        .flatMap(
          (l) =>
            l.replace(/^\/\/\s*(go:build|\+build)/, "").match(/[\w.]+/g) ?? [],
        )
        .filter((tag) => tag !== "ignore"),
    ),
  ]
  if (tags.length > 12) return false
  for (let bits = 0; bits < 2 ** tags.length; bits++) {
    const set = new Set(tags.filter((_, i) => bits & (1 << i)))
    if (constraints.every((c) => c(set))) return false
  }
  return true
}

/**
 * The rule for one Go file of a folder, in name order: "main" when it makes
 * the folder a `main` package, "next" when its build constraint excludes it
 * from every build (`//go:build ignore`: a generator that `go run` starts is
 * no part of the package, so read the next file), and "none" otherwise. All
 * files of a Go package that the go tool builds have one package clause.
 */
function goMainStep(text) {
  let inComment = false
  const constraints = []
  for (const raw of text.split("\n")) {
    let line = raw.trim()
    if (inComment) {
      const end = line.indexOf("*/")
      if (end === -1) continue
      inComment = false
      line = line.slice(end + 2).trim()
    }
    if (/^\/\/\s*(go:build|\+build)\s/.test(line)) {
      constraints.push(line)
      continue
    }
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2)
      if (end === -1) {
        inComment = true
        continue
      }
      line = line.slice(end + 2).trim()
    }
    if (line === "" || line.startsWith("//")) continue
    if (goIgnoredBuild(constraints)) return "next"
    return /^package\s+main(\s|;|\/\/|$)/.test(line) ? "main" : "none"
  }
  return "none"
}

/** True for a Go file that the go tool builds: not a test, and no `_` or `.` at the start of its name. */
function goBuildFile(path) {
  const name = posix.basename(path)
  return (
    name.endsWith(".go") &&
    !name.endsWith("_test.go") &&
    !name.startsWith("_") &&
    !name.startsWith(".")
  )
}

/** The Go file of the folder that makes it a `main` package, or null. One file at a time, for one folder. */
export function goMainFile(source, files, dir) {
  const prefix = dir === "." ? "" : `${dir}/`
  const list = [...files]
    .filter(
      (f) =>
        f.startsWith(prefix) &&
        !f.slice(prefix.length).includes("/") &&
        goBuildFile(f),
    )
    .sort()
  for (const file of list) {
    const step = goMainStep(readTracked(source, file))
    if (step !== "next") return step === "main" ? file : null
  }
  return null
}

/**
 * The Go `main` packages (binaries), as [folder, Go file with the package
 * clause]. The folder is in a Go module (it or a parent folder has a go.mod
 * that the script reads) and not in a test or example folder.
 */
function goMainPackages(source, files, markersOf) {
  const modules = new Set(
    [...markersOf.keys()].filter((d) => markersOf.get(d).includes("go.mod")),
  )
  if (modules.size === 0) return []
  const inModule = (dir) => {
    for (let d = dir; ; d = posix.dirname(d)) {
      if (modules.has(d)) return true
      if (d === ".") return false
    }
  }
  const byFolder = new Map()
  for (const file of files) {
    if (!goBuildFile(file)) continue
    const dir = posix.dirname(file)
    // The go tool skips a folder whose name starts with `_` or `.`.
    if (dir.split("/").some((segment) => segment.startsWith("_"))) continue
    if (ignoredFolder(dir) || inTestFolder(dir) || !safePath(dir)) continue
    if (dir.split("/").length > MAX_DEPTH) continue
    byFolder.set(dir, [...(byFolder.get(dir) ?? []), file])
  }
  for (const [dir, list] of byFolder)
    if (inModule(dir)) list.sort()
    else byFolder.delete(dir)
  // The same rule as `goMainFile`, with the files of each round read in one
  // git call: the first file of each folder, then the next file only where
  // the rule says "next".
  const out = []
  let round = [...byFolder.keys()].map((dir) => [dir, 0])
  while (round.length) {
    const steps = readTrackedMany(
      source,
      round.map(([dir, i]) => byFolder.get(dir)[i]),
      goMainStep,
    )
    const next = []
    for (const [dir, i] of round) {
      const file = byFolder.get(dir)[i]
      const step = steps.get(file)
      if (step === "main") out.push([dir, file])
      else if (step === "next" && i + 1 < byFolder.get(dir).length)
        next.push([dir, i + 1])
    }
    round = next
  }
  return out
}

export function discoverRoots(source) {
  const files = trackedFiles(source)
  const folders = new Set(["."])
  const markersOf = new Map()
  let unsafeFolder = false
  let tooDeep = false
  for (const file of files) {
    const parts = file.split("/")
    for (let i = 1; i < parts.length && i <= MAX_DEPTH; i++)
      folders.add(parts.slice(0, i).join("/"))
    const name = parts.at(-1)
    if (!PACKAGE_MARKERS.includes(name)) continue
    const dir = parts.length === 1 ? "." : parts.slice(0, -1).join("/")
    if (ignoredFolder(dir)) continue
    if (parts.length - 1 > MAX_DEPTH) {
      tooDeep = true
      continue
    }
    if (!safePath(dir)) {
      unsafeFolder = true
      continue
    }
    markersOf.set(dir, [...(markersOf.get(dir) ?? []), name].sort())
  }
  const rootFiles = new Set(files.filter((f) => !f.includes("/")))
  const nested = [...markersOf.keys()].filter((d) => d !== ".").sort()
  const candidate = (path) => ({ path, manifests: markersOf.get(path) ?? [] })

  const roots = new Map()
  const addRoot = (path, evidence) => {
    const root = roots.get(path) ?? {
      path,
      manifests: markersOf.get(path) ?? [],
      evidence: [],
    }
    if (!root.evidence.includes(evidence)) root.evidence.push(evidence)
    roots.set(path, root)
  }
  const ambiguous = []
  const skipped = []
  if (unsafeFolder)
    skipped.push({
      manifest: null,
      reason:
        "A folder with a package manifest has a name that the script does not quote",
    })
  if (tooDeep)
    skipped.push({
      manifest: null,
      reason: `The script did not read a folder that is more than ${MAX_DEPTH} levels deep`,
    })
  const skipEntry = (manifest, reason) =>
    skipped.push({ manifest, reason: `The script skipped an entry: ${reason}` })

  /** Adds the roots that one workspace manifest lists, and gives them. */
  const readManifest = (found) => {
    if (found.unreadable) {
      ambiguous.push({
        manifest: found.manifest,
        reason: found.unreadable,
        candidates: nested.map(candidate),
      })
      return []
    }
    if (found.entries.length > MAX_ENTRIES)
      skipped.push({
        manifest: found.manifest,
        reason: `The script read only the first ${MAX_ENTRIES} entries of the file`,
      })
    const entries = []
    for (const raw of found.entries.slice(0, MAX_ENTRIES)) {
      const exclude = raw.startsWith("!")
      const entry = cleanEntry(exclude ? raw.slice(1) : raw)
      const matcher = globMatcher(entry)
      if (matcher.skip) skipEntry(found.manifest, matcher.skip)
      else entries.push({ entry, exclude, matches: matcher.matches })
    }
    let budgetSkipped = false
    const budgetSkip = () => {
      if (budgetSkipped) return
      budgetSkipped = true
      skipEntry(
        found.manifest,
        "the match budget of the script ran out, so it read no more entries",
      )
    }
    const hasMarker = (dir) =>
      found.markers
        ? found.markers.some((m) => markersOf.get(dir)?.includes(m))
        : folders.has(dir)
    const excludes = entries.filter((e) => e.exclude)
    const excluded = (dir) => excludes.some((e) => e.matches(dir))
    const members = []
    for (const { entry, matches } of entries.filter((e) => !e.exclude)) {
      if (!matchBudgetLeft()) {
        budgetSkip()
        continue
      }
      const named = isGlob(entry) ? nested.filter(matches) : [entry]
      const hits = named.filter(
        (dir) => folders.has(dir) && !excluded(dir) && hasMarker(dir),
      )
      // A run out of budget can miss a match or an exclude: drop its result.
      if (!matchBudgetLeft()) {
        budgetSkip()
        continue
      }
      for (const dir of hits) addRoot(dir, found.manifest)
      members.push(...hits)
      if (hits.length === 0 && (named.length === 0 || !named.every(excluded))) {
        const what = found.markers ? found.markers.join(" or ") : "files"
        ambiguous.push({
          manifest: found.manifest,
          reason: `These entries name no folder with ${what}: ${entry}`,
          candidates: named
            .filter(
              (dir) => folders.has(dir) && !excluded(dir) && safePath(dir),
            )
            .map(candidate),
        })
      }
    }
    if (found.rootPackage) {
      addRoot(found.dir, found.manifest)
      members.push(found.dir)
    }
    return members
  }

  const manifests = workspaceManifests(source, rootFiles)
  const cargo = cargoWorkspaces(source, markersOf)
  // The fallback and nx.json look only at the manifests of the repository root.
  const rootManifests = [...manifests, ...cargo.filter((w) => w.rootLevel)]
  // The members of each Cargo workspace, for its path dependencies.
  const listed = new Map()
  for (const found of rootManifests) listed.set(found, readManifest(found))
  if (rootFiles.has("nx.json") && roots.size === 0)
    ambiguous.push({
      manifest: "nx.json",
      reason: "nx.json has no project list that the script can read",
      candidates: nested.map(candidate),
    })

  if (rootManifests.length === 0 && !rootFiles.has("nx.json")) {
    addRoot(".", ".")
    if (nested.length)
      ambiguous.push({
        manifest: null,
        reason: "No workspace manifest names these folders",
        candidates: nested.map(candidate),
      })
  }

  for (const found of cargo.filter((w) => !w.rootLevel))
    listed.set(found, readManifest(found))
  for (const found of cargo)
    for (const [dir, manifest] of cargoPathMembers(
      source,
      markersOf,
      found,
      listed.get(found),
    ))
      addRoot(dir, manifest)
  for (const [dir, file] of goMainPackages(source, files, markersOf))
    addRoot(dir, file)

  // An entry with no candidate gives the model no choice, so no model runs for it.
  for (const entry of ambiguous.filter((a) => a.candidates.length === 0))
    skipped.push({ manifest: entry.manifest, reason: entry.reason })
  // A candidate that is a root already is no choice, and neither is the
  // folder of a Cargo workspace with no `[package]`, which the script read.
  // An entry that this leaves with no candidate is resolved, not skipped.
  const virtualWorkspaces = new Set(
    cargo.filter((w) => !w.rootPackage && w.dir !== ".").map((w) => w.dir),
  )
  for (const entry of ambiguous)
    entry.candidates = entry.candidates.filter(
      (c) => !roots.has(c.path) && !virtualWorkspaces.has(c.path),
    )

  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const byManifest = (a, b) =>
    byText(a.manifest ?? "", b.manifest ?? "") || byText(a.reason, b.reason)
  return fitResult({
    roots: [...roots.values()]
      .map((r) => ({ ...r, evidence: r.evidence.sort() }))
      .sort((a, b) => byText(a.path, b.path)),
    ambiguous: ambiguous.filter((a) => a.candidates.length).sort(byManifest),
    skipped: skipped.sort(byManifest),
  })
}

/**
 * The result at most `MAX_RESULT_BYTES` large. Above it, the script removes
 * items from the end: candidates first, then skipped entries, then roots.
 * It adds one skipped entry that says so. The size of the result sets the
 * limit, not a count of roots.
 */
export function fitResult(result, maxBytes = MAX_RESULT_BYTES) {
  const size = (value) => Buffer.byteLength(JSON.stringify(value)) + 1
  if (size(result) <= maxBytes) return result
  const count = (list) => list.reduce((n, a) => n + a.candidates.length, 0)
  const note = (roots, candidates, skipped) => ({
    manifest: null,
    reason: `The result of the script must be at most ${maxBytes} bytes, so it gives only the first ${roots} roots, ${candidates} candidates, and ${skipped} other skipped entries`,
  })
  // The counts can only decrease. Thus the note with the first counts is
  // the largest note.
  const room =
    maxBytes -
    size(
      note(result.roots.length, count(result.ambiguous), result.skipped.length),
    )
  let total = size(result)
  const ambiguous = result.ambiguous.map((a) => ({
    ...a,
    candidates: [...a.candidates],
  }))
  const skipped = [...result.skipped]
  const roots = [...result.roots]
  /** Removes the next item in the order of the rule; false when none is left. */
  const removeOne = () => {
    const entry = ambiguous.findLast((a) => a.candidates.length > 0)
    const item = entry ? entry.candidates.pop() : (skipped.pop() ?? roots.pop())
    if (item !== undefined) total -= size(item)
    return item !== undefined
  }
  // The sizes of the items give a fast first estimate.
  while (total > room && removeOne());
  const fitted = () => {
    const kept = ambiguous.filter((a) => a.candidates.length > 0)
    return {
      roots: [...roots],
      ambiguous: kept,
      skipped: [...skipped, note(roots.length, count(kept), skipped.length)],
    }
  }
  // The estimate can be some bytes off (an array that becomes empty has no
  // comma), so the script checks the serialized result.
  let out = fitted()
  while (size(out) > maxBytes && removeOne()) out = fitted()
  return out
}
