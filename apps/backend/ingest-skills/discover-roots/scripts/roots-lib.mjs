// Find the code roots of a source checkout from its workspace manifests.
// The host plans the root steps from this result. A model looks only at the
// `ambiguous` entries, and it can choose only from their `candidates`.
//
// Result: { roots: [{ path, manifests, evidence }],
//           ambiguous: [{ manifest, reason, candidates }] }
// `path` is "." for the repository root. `evidence` names the workspace
// manifests that list the root, or "." for the single-root fallback.

import { execFileSync } from "node:child_process"

/** Files that make a folder a package. */
export const PACKAGE_MARKERS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]

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

export function readTracked(source, path) {
  try {
    return execFileSync("git", ["-C", source, "show", `HEAD:${path}`], {
      maxBuffer: 16 * 1024 * 1024,
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

function globRegex(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*" && glob[i + 1] === "*") {
      // `a/**` also matches `a`'s children at any depth; `**/` matches zero or more folders.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?"
        i += 2
      } else {
        out += ".*"
        i += 1
      }
    } else if (ch === "*") out += "[^/]*"
    else if (ch === "?") out += "[^/]"
    else if (ch === "{") out += "(?:"
    else if (ch === "}") out += ")"
    else if (ch === ",") out += "|"
    else if (/[.+^$()|[\]\\]/.test(ch)) out += `\\${ch}`
    else out += ch
  }
  return new RegExp(`^${out}$`)
}

const isGlob = (entry) => /[*?{[]/.test(entry)

/** The TOML lines of each `[table]`, keyed by table name. Enough for manifests. */
function tomlTables(text) {
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

/** Strings of a TOML array `key = [ ... ]` in one table. */
export function tomlStringArray(tables, table, key) {
  const body = (tables.get(table) ?? []).join("\n")
  const match = new RegExp(
    `(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(body)
  if (!match) return []
  return [...match[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  )
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

/**
 * The workspace manifests at the repository root, as
 * { manifest, markers, entries } or { manifest, unreadable }.
 * `entries` are folder paths or globs; a `!` entry excludes.
 */
function workspaceManifests(source, rootFiles) {
  const found = []
  const read = (path) => readTracked(source, path)
  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    if (!rootFiles.has(name)) continue
    const items = yamlBlockList(read(name), "packages")
    found.push(
      items?.length
        ? { manifest: name, markers: ["package.json"], entries: items }
        : {
            manifest: name,
            unreadable: "The script found no package list in the file",
          },
    )
  }
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
  if (rootFiles.has("lerna.json")) {
    const list = stringList(parseJson(read("lerna.json"))?.packages)
    found.push(
      list?.length
        ? { manifest: "lerna.json", markers: ["package.json"], entries: list }
        : {
            manifest: "lerna.json",
            unreadable: "The script found no package list in the file",
          },
    )
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
    const text = read("go.work").replace(/\/\/.*$/gm, "")
    const entries = []
    for (const block of text.matchAll(/\buse\s*\(([\s\S]*?)\)/g))
      entries.push(
        ...block[1]
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      )
    for (const line of text.matchAll(/^\s*use\s+([^\s()]+)\s*$/gm))
      entries.push(line[1])
    found.push(
      entries.length
        ? { manifest: "go.work", markers: ["go.mod"], entries }
        : {
            manifest: "go.work",
            unreadable: "The script found no use directive in the file",
          },
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
    for (const call of read(name).matchAll(/^\s*include\b\s*\(?([^\n)]*)/gm))
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
  for (const file of files) {
    const parts = file.split("/")
    for (let i = 1; i < parts.length; i++)
      folders.add(parts.slice(0, i).join("/"))
    const name = parts.at(-1)
    if (!PACKAGE_MARKERS.includes(name)) continue
    const dir = parts.length === 1 ? "." : parts.slice(0, -1).join("/")
    if (ignoredFolder(dir)) continue
    markersOf.set(dir, [...(markersOf.get(dir) ?? []), name].sort())
  }
  const rootFiles = new Set(files.filter((f) => !f.includes("/")))
  const nested = [...markersOf.keys()].filter((d) => d !== ".").sort()

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

  const manifests = workspaceManifests(source, rootFiles)
  for (const found of manifests) {
    if (found.unreadable) {
      ambiguous.push({
        manifest: found.manifest,
        reason: found.unreadable,
        candidates: nested,
      })
      continue
    }
    const hasMarker = (dir) =>
      found.markers
        ? found.markers.some((m) => markersOf.get(dir)?.includes(m))
        : folders.has(dir)
    const excludes = found.entries
      .filter((e) => e.startsWith("!"))
      .map((e) => globRegex(cleanEntry(e.slice(1))))
    const excluded = (dir) => excludes.some((re) => re.test(dir))
    for (const raw of found.entries.filter((e) => !e.startsWith("!"))) {
      const entry = cleanEntry(raw)
      const matches = isGlob(entry)
        ? nested.filter((dir) => globRegex(entry).test(dir))
        : [entry]
      const hits = matches.filter(
        (dir) => folders.has(dir) && !excluded(dir) && hasMarker(dir),
      )
      for (const dir of hits) addRoot(dir, found.manifest)
      if (
        hits.length === 0 &&
        (matches.length === 0 || !matches.every(excluded))
      ) {
        const what = found.markers ? found.markers.join(" or ") : "files"
        ambiguous.push({
          manifest: found.manifest,
          reason: `These entries name no folder with ${what}: ${entry}`,
          candidates: matches.filter(
            (dir) => folders.has(dir) && !excluded(dir),
          ),
        })
      }
    }
    if (found.rootPackage) addRoot(".", found.manifest)
  }
  if (rootFiles.has("nx.json") && roots.size === 0)
    ambiguous.push({
      manifest: "nx.json",
      reason: "nx.json has no project list that the script can read",
      candidates: nested,
    })

  if (manifests.length === 0 && !rootFiles.has("nx.json")) {
    addRoot(".", ".")
    if (nested.length)
      ambiguous.push({
        manifest: null,
        reason: "No workspace manifest names these folders",
        candidates: nested,
      })
  }

  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  return {
    roots: [...roots.values()]
      .map((r) => ({ ...r, evidence: r.evidence.sort() }))
      .sort((a, b) => byText(a.path, b.path)),
    ambiguous: ambiguous.sort(
      (a, b) =>
        byText(a.manifest ?? "", b.manifest ?? "") ||
        byText(a.reason, b.reason),
    ),
  }
}
