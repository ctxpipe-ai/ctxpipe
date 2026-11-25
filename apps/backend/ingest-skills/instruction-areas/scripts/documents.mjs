#!/usr/bin/env node
// Select the documents that state the practice of a source repository
// (concept section 5.4): agent instruction files, rules, skills,
// CONTRIBUTING, ADRs, lessons-learned files, and package READMEs. The agent
// reads these first; a rule from a document comes before a rule from code.
//
//   node documents.mjs --source <checkout> --roots <root-to-file map> [--count]
//
// The documents are the input of the cursor of the skill (CTX-1570). The
// list has no count limit. With --count, the script prints
// `{"count": <documents>}`: the host takes it as the length of the input.
// Else it prints the documents of this page:
// { documents: [{ path, class, bytes, truncated }], page: { from, to, of },
// skipped: [...] }. A page starts at the cursor of the page before it
// (`cursorAt` of step.json) and holds the next documents while their read
// bytes fit in 256 KiB, at least one. `class` orders the list:
// instructions, rules, skills, contributing, adr, lessons, readme.
// `truncated` is true when the file is larger than 64 KiB; the agent reads
// only its first 64 KiB.
//
// The source repository is hostile: the script lists tracked regular files
// only, skips symbolic links and unsafe paths, and never reads a file.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { posix } from "node:path"
import { pathToFileURL } from "node:url"

import { currentStep, parseArgs } from "../../bin/stage-lib.mjs"
import {
  inTestFixture,
  safePath,
  testFixtureSkips,
} from "../../discover-roots/scripts/roots-lib.mjs"

const READ_LIMIT = 64 * 1024
const IGNORED = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
])
const CLASSES = [
  "instructions",
  "rules",
  "skills",
  "contributing",
  "adr",
  "lessons",
  "readme",
]

/** The class of a tracked path, or null when the path is not a practice document. */
export function documentClass(path, readmeFolders) {
  const segments = path.split("/")
  const name = segments.at(-1) ?? ""
  const lower = path.toLowerCase()
  const top = segments[0] ?? ""
  if (
    segments.some((s) => IGNORED.has(s)) ||
    segments
      .slice(0, -1)
      .some(
        (s) =>
          s.startsWith(".") &&
          ![".cursor", ".claude", ".agents", ".github", ".ai"].includes(s),
      )
  )
    return null
  if (/^(agents|claude)\.md$/i.test(name) || name === ".cursorrules")
    return "instructions"
  if (lower === ".github/copilot-instructions.md") return "instructions"
  if (
    (top === ".cursor" || top === ".claude") &&
    segments[1] === "rules" &&
    /\.(md|mdc)$/.test(name)
  )
    return "rules"
  if (
    [".agents", ".claude", ".cursor"].includes(top) &&
    segments[1] === "skills" &&
    name === "SKILL.md"
  )
    return "skills"
  if (/^contributing(\.[a-z]+)?$/i.test(name) && /\.md$/i.test(name))
    return "contributing"
  if (
    /\.md$/i.test(name) &&
    (segments.some((s) => /^(adrs?|architecture-decisions)$/i.test(s)) ||
      /^adr[-_]?\d+/i.test(name) ||
      (segments.some((s) => /^decisions$/i.test(s)) && /^\d+|^adr/i.test(name)))
  )
    return "adr"
  if (/lessons[-_ ]?learned/i.test(name) && /\.md$/i.test(name))
    return "lessons"
  if (/^readme\.md$/i.test(name) && readmeFolders.has(posix.dirname(path)))
    return "readme"
  return null
}

/** Tracked regular files with sizes: [{ path, bytes }]. */
function trackedSizes(source) {
  const out = execFileSync(
    "git",
    ["-C", source, "ls-tree", "-r", "-l", "-z", "HEAD"],
    { maxBuffer: 256 * 1024 * 1024 },
  ).toString("utf8")
  const files = []
  for (const record of out.split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    const [mode, type, , size] = record.slice(0, tab).trim().split(/\s+/)
    if (type === "blob" && mode !== "120000")
      files.push({ path: record.slice(tab + 1), bytes: Number(size) || 0 })
  }
  return files
}

/**
 * @param {string} source checkout
 * @param {string[]} rootPaths root folders; the repository root is always one. Without roots, README folders are the root and its direct children.
 */
export function selectDocuments(source, rootPaths = null) {
  const readmeFolders = new Set(["."])
  if (rootPaths)
    for (const p of rootPaths) readmeFolders.add(p === "" ? "." : p)
  const files = trackedSizes(source)
  if (!rootPaths)
    for (const { path } of files)
      if (path.split("/").length === 3) readmeFolders.add(posix.dirname(path))
  const documents = []
  const skipped = []
  const fixtures = []
  for (const { path, bytes } of files) {
    const kind = documentClass(path, readmeFolders)
    if (!kind) continue
    if (inTestFixture(path)) {
      fixtures.push(path)
      continue
    }
    if (!safePath(path)) {
      skipped.push({
        path: null,
        reason: "A path has characters that the script does not list",
      })
      continue
    }
    documents.push({ path, class: kind, bytes, truncated: bytes > READ_LIMIT })
  }
  for (const { path, reason } of testFixtureSkips(fixtures))
    skipped.push({ path, reason })
  documents.sort(
    (a, b) =>
      CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) ||
      a.path.split("/").length - b.path.split("/").length ||
      (a.path < b.path ? -1 : 1),
  )
  return { documents, skipped }
}

/**
 * The documents of the page that starts at `from`: the next documents while
 * their read bytes fit in 256 KiB, at least one, so that the model can read
 * them before the step checkpoint. `to` is the cursor after the page.
 */
export function documentPage(documents, from) {
  const budget = 256 * 1024
  const start = Math.min(from, documents.length)
  let to = start
  let read = 0
  while (to < documents.length) {
    const bytes = Math.min(documents[to].bytes, READ_LIMIT)
    if (to > start && read + bytes > budget) break
    read += bytes
    to++
  }
  return { documents: documents.slice(start, to), from: start, to }
}

function main() {
  const { root, args: argv } = parseArgs()
  let source = null
  let rootsFile = null
  let count = false
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--source") source = argv[i + 1]
    else if (argv[i] === "--roots") rootsFile = argv[i + 1]
    else if (argv[i] === "--count") {
      count = true
      i--
    }
    // The other host inputs (ADR-052 section 6); the list needs neither.
    else if (
      argv[i] === "--source-url" ||
      argv[i] === "--source-path" ||
      argv[i] === "--path"
    )
      continue
    else {
      process.stderr.write(`Unknown argument ${argv[i]}\n`)
      process.exit(1)
    }
  }
  if (!source || !rootsFile) {
    process.stderr.write(
      "Usage: documents.mjs --source <checkout> --source-url <url> --source-path <path> --roots <file> [--count]\n",
    )
    process.exit(1)
  }
  const listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
  const roots = Array.isArray(listed)
    ? listed
        .map((r) => r?.path)
        .filter((p) => typeof p === "string" && safePath(p))
    : null
  const { documents, skipped } = selectDocuments(source, roots)
  if (count) {
    process.stdout.write(`${JSON.stringify({ count: documents.length })}\n`)
    return
  }
  const page = documentPage(documents, currentStep(root).cursorAt)
  process.stdout.write(
    `${JSON.stringify({
      documents: page.documents,
      page: { from: page.from, to: page.to, of: documents.length },
      skipped,
    })}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
