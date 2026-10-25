// Find the code roots of a source checkout from its workspace manifests.
// The host plans the root steps from this result. A model looks only at the
// `ambiguous` entries, and it can choose only from their `candidates`
// (apps/backend/src/domain/ingestion/discovered-roots.ts checks that).
//
// Result: { roots: [{ path, manifests, evidence }],
//           ambiguous: [{ manifest, reason, candidates: [{ path, manifests }] }],
//           skipped: [{ manifest, reason }] }
// `path` is "." for the repository root. `evidence` names the workspace
// manifests that list the root, or "." for the single-root fallback. An
// ambiguous entry always has a candidate; an entry with none is in `skipped`.
//
// The source repository is hostile. The script never builds a regular
// expression from its text, and it caps the length and the count of entries.

import { execFileSync } from "node:child_process"

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
    const header = /^\s*\[([^[\]]+)\]\s*$/.exec(line)
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
  if (rootFiles.has("Cargo.toml")) {
    const tables = tomlTables(read("Cargo.toml"))
    const members = tomlStringArray(tables, "workspace", "members")
    const exclude = tomlStringArray(tables, "workspace", "exclude")
    if (members.length)
      found.push({
        manifest: "Cargo.toml",
        markers: ["Cargo.toml"],
        entries: [...members, ...exclude.map((e) => `!${e}`)],
        rootPackage: tables.has("package"),
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

  const manifests = workspaceManifests(source, rootFiles)
  for (const found of manifests) {
    if (found.unreadable) {
      ambiguous.push({
        manifest: found.manifest,
        reason: found.unreadable,
        candidates: nested.map(candidate),
      })
      continue
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
    if (found.rootPackage) addRoot(".", found.manifest)
  }
  if (rootFiles.has("nx.json") && roots.size === 0)
    ambiguous.push({
      manifest: "nx.json",
      reason: "nx.json has no project list that the script can read",
      candidates: nested.map(candidate),
    })

  if (manifests.length === 0 && !rootFiles.has("nx.json")) {
    addRoot(".", ".")
    if (nested.length)
      ambiguous.push({
        manifest: null,
        reason: "No workspace manifest names these folders",
        candidates: nested.map(candidate),
      })
  }

  if (rootsFull)
    skipped.push({
      manifest: null,
      reason: `The script gives at most ${MAX_ROOTS} roots`,
    })

  // An entry with no candidate gives the model no choice, so no model runs for it.
  for (const entry of ambiguous.filter((a) => a.candidates.length === 0))
    skipped.push({ manifest: entry.manifest, reason: entry.reason })

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
