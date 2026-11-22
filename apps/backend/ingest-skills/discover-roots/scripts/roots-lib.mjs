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
export const MAX_ROOTS = 2000
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
 * Text of tracked files at HEAD, keyed by path, with two git calls for each
 * 500 paths. Like `readTracked`, a file that is missing or larger than 1 MiB
 * is "", so the script never holds more than 500 MiB of file text.
 */
export function readTrackedMany(source, paths) {
  const out = new Map()
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
      out.set(path, "")
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
      out.set(path, buffer.toString("utf8", at, at + size))
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

/**
 * The Cargo workspaces: each tracked `Cargo.toml` with a `[workspace]` table,
 * as a workspace manifest whose entries are relative to the repository
 * root. A nested workspace is not in a test or example folder.
 */
function cargoWorkspaces(source, markersOf) {
  const dirs = [...markersOf.keys()]
    .filter((dir) => markersOf.get(dir).includes("Cargo.toml"))
    .filter((dir) => dir === "." || !inTestFolder(dir))
    .sort()
  const manifestOf = (dir) => (dir === "." ? "Cargo.toml" : `${dir}/Cargo.toml`)
  const texts = readTrackedMany(source, dirs.map(manifestOf))
  const found = []
  for (const dir of dirs) {
    const tables = tomlTables(texts.get(manifestOf(dir)) ?? "")
    if (!tables.has("workspace")) continue
    const members = tomlStringArray(tables, "workspace", "members")
    const exclude = tomlStringArray(tables, "workspace", "exclude")
    const entries = []
    for (const [raw, prefix] of [
      ...members.map((m) => [m, ""]),
      ...exclude.map((e) => [e, "!"]),
    ]) {
      const path = joinFolder(dir, cleanEntry(raw))
      if (path) entries.push(`${prefix}${path}`)
    }
    found.push({
      manifest: manifestOf(dir),
      markers: ["Cargo.toml"],
      dir,
      entries,
      excludes: exclude
        .map((e) => joinFolder(dir, cleanEntry(e)))
        .filter(Boolean)
        .map((e) => globMatcher(e))
        .filter((m) => m.matches),
      rootPackage: tables.has("package"),
      // As before, a root workspace with no `members` is not a workspace
      // manifest for the single-root fallback.
      rootLevel: dir === "." && members.length > 0,
    })
  }
  // A `[workspace]` with no members and no `[package]` lists nothing.
  return found.filter((w) => w.entries.length > 0 || w.rootPackage)
}

const CARGO_DEPENDENCY_TABLES = new Set([
  "dependencies",
  "dev-dependencies",
  "dev_dependencies",
  "build-dependencies",
  "build_dependencies",
])

/** The `path` values of the dependency tables of a `Cargo.toml`, also `[workspace.dependencies]` and `[target.*.dependencies]`. Not `[patch]` or `[replace]`. */
export function cargoPathDependencies(text) {
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
 * The path dependencies that are members of a Cargo workspace:
 * { members: [[folder, manifest that names it]], budgetOut }. Cargo makes each path dependency of a
 * member a member too, when it is in the workspace folder and not excluded,
 * so the script follows them from member to member.
 */
function cargoPathMembers(source, markersOf, workspace) {
  const out = []
  const seen = new Set(workspace.members)
  let queue = [...new Set([workspace.dir, ...workspace.members])]
  const manifestOf = (dir) => (dir === "." ? "Cargo.toml" : `${dir}/Cargo.toml`)
  const inside = (dir) =>
    workspace.dir === "." || dir.startsWith(`${workspace.dir}/`)
  while (queue.length) {
    const texts = readTrackedMany(source, queue.map(manifestOf))
    const next = []
    for (const crate of queue) {
      // The workspace manifest is read for `[workspace.dependencies]`; it is
      // a member only when it has a `[package]`.
      for (const relative of cargoPathDependencies(
        texts.get(manifestOf(crate)) ?? "",
      )) {
        const dir = joinFolder(crate, cleanEntry(relative))
        if (
          !dir ||
          seen.has(dir) ||
          !inside(dir) ||
          !markersOf.get(dir)?.includes("Cargo.toml") ||
          workspace.excludes.some((e) => e.matches(dir))
        )
          continue
        // A run out of budget can miss an exclude: give no more members.
        if (!matchBudgetLeft()) return { members: out, budgetOut: true }
        seen.add(dir)
        out.push([dir, manifestOf(crate)])
        next.push(dir)
      }
    }
    queue = next
  }
  return { members: out, budgetOut: false }
}

/**
 * True when the Go file is in `package main` and its build constraint does
 * not name `ignore` (a generator that `go run` starts is not a binary).
 */
export function goFileIsMain(text) {
  let inComment = false
  for (const raw of text.split("\n")) {
    let line = raw.trim()
    if (inComment) {
      const end = line.indexOf("*/")
      if (end === -1) continue
      inComment = false
      line = line.slice(end + 2).trim()
    }
    if (/^\/\/\s*(go:build|\+build)\s/.test(line)) {
      if (/[\s(|&,]ignore($|[\s)|&,])/.test(line.replace(/^\/\/\s*/, " ")))
        return false
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
    return /^package\s+main(\s|;|\/\/|$)/.test(line)
  }
  return false
}

/** The Go files of a folder that can hold its package clause: not tests, sorted. */
export function goPackageFiles(files, dir) {
  const prefix = dir === "." ? "" : `${dir}/`
  return [...files]
    .filter(
      (f) =>
        f.startsWith(prefix) &&
        !f.slice(prefix.length).includes("/") &&
        f.endsWith(".go") &&
        !f.endsWith("_test.go"),
    )
    .sort()
}

/** The Go file of the folder that makes it a `main` package, or null. One file at a time, for one folder. */
export function goMainFile(source, files, dir) {
  for (const file of goPackageFiles(files, dir)) {
    const text = readTracked(source, file)
    if (goFileIsMain(text)) return file
    if (!/^\s*package\s+main\b/m.test(text)) return null
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
    if (!file.endsWith(".go") || file.endsWith("_test.go")) continue
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
  // All files of a Go package have one package clause, so the script reads
  // one file of each folder, and the next one only for a file that a build
  // constraint ignores.
  const out = []
  let round = [...byFolder.keys()].map((dir) => [dir, 0])
  while (round.length) {
    const texts = readTrackedMany(
      source,
      round.map(([dir, i]) => byFolder.get(dir)[i]),
    )
    const next = []
    for (const [dir, i] of round) {
      const file = byFolder.get(dir)[i]
      const text = texts.get(file) ?? ""
      if (goFileIsMain(text)) out.push([dir, file])
      else if (
        /^\s*package\s+main\b/m.test(text) &&
        i + 1 < byFolder.get(dir).length
      )
        next.push([dir, i + 1])
    }
    round = next
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
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
  const allNested = [...markersOf.keys()].filter((d) => d !== ".").sort()
  const nested = allNested.slice(0, MAX_ROOTS)
  const candidate = (path) => ({ path, manifests: markersOf.get(path) ?? [] })

  const roots = new Map()
  let rootsFull = false
  const addRoot = (path, evidence) => {
    if (!roots.has(path) && roots.size >= MAX_ROOTS) {
      rootsFull = true
      return
    }
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
  if (allNested.length > nested.length)
    skipped.push({
      manifest: null,
      reason: `The script read only the first ${MAX_ROOTS} folders with a package manifest`,
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
  for (const found of rootManifests) found.members = readManifest(found)
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
    found.members = readManifest(found)
  for (const found of cargo) {
    const { members, budgetOut } = cargoPathMembers(source, markersOf, found)
    for (const [dir, manifest] of members) addRoot(dir, manifest)
    if (budgetOut)
      skipEntry(
        found.manifest,
        "the match budget of the script ran out, so it followed no more path dependencies",
      )
  }
  for (const [dir, file] of goMainPackages(source, files, markersOf))
    addRoot(dir, file)

  if (rootsFull)
    skipped.push({
      manifest: null,
      reason: `The script gives at most ${MAX_ROOTS} roots`,
    })

  // An entry with no candidate gives the model no choice, so no model runs for
  // it. A candidate that is a root already is no choice either.
  for (const entry of ambiguous.filter((a) => a.candidates.length === 0))
    skipped.push({ manifest: entry.manifest, reason: entry.reason })
  for (const entry of ambiguous)
    entry.candidates = entry.candidates.filter((c) => !roots.has(c.path))

  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const byManifest = (a, b) =>
    byText(a.manifest ?? "", b.manifest ?? "") || byText(a.reason, b.reason)
  return {
    roots: [...roots.values()]
      .map((r) => ({ ...r, evidence: r.evidence.sort() }))
      .sort((a, b) => byText(a.path, b.path)),
    ambiguous: ambiguous.filter((a) => a.candidates.length).sort(byManifest),
    skipped: skipped.sort(byManifest),
  }
}
