#!/usr/bin/env node

// Count a code pattern in a source checkout and tell whether the good-practice
// rules of concept section 5.4 let a rule be inferred from it. The agent never
// counts. It names a literal text; this script does the counting.
//
//   node patterns.mjs --source <checkout> [--now <ISO date>] --pattern <literal>...
//
// Result: { patterns: [{ pattern, placement, reasons, files, directories,
//   evidence, trend: { older, newest, state } }] }
// `placement` is "rules" (an inferred rule is allowed), "being-replaced" (the
// pattern is real but falling), or "none". `reasons` lists the criteria that
// failed. `evidence` holds at most 5 paths, spread over the folders.
//
// The source repository is hostile. A pattern is a fixed string, never a
// regular expression, and it goes to git only after `-e`. The script reads at
// most MAX_FILES files of at most 1 MiB, and it ends a history walk at
// MAX_HISTORY_BYTES. Each git call has a timeout, and a history walk reads
// at most MAX_COMMITS commits. The command line takes at most
// MAX_CALLS_PER_STEP calls in one step (one sandbox), with at most
// MAX_PATTERNS_PER_CALL patterns each; the changed paths are cached.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { pathToFileURL } from "node:url"

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_FILES = 3
const MIN_DIRECTORIES = 2
const MAX_FILES = 500
const MAX_EVIDENCE = 5
const MAX_HISTORY_BYTES = 128 * 1024 * 1024
const MAX_COMMITS = 5000
const GIT_TIMEOUT_MS = 60_000
export const MAX_CALLS_PER_STEP = 10
export const MAX_PATTERNS_PER_CALL = 10
const NEAR_LINES = 3

/** Folder names that hold generated, vendored, fixture, or legacy code. */
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "vendored",
  "third_party",
  "dist",
  "build",
  "generated",
  "__generated__",
  "__snapshots__",
  "fixtures",
  "__fixtures__",
  "testdata",
  "legacy",
  "deprecated",
])
const EXCLUDED_NAME =
  /\.(?:min|generated|gen|pb)\.[a-z]+$|_pb2\.py$|\.lock$|-lock\.[a-z]+$|^package-lock\.json$/i
const GENERATED_HEADER =
  /@generated|DO NOT EDIT|Code generated|auto-?generated/i
const SUPPRESSION =
  /eslint-disable|biome-ignore|oxlint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|#\s*noqa|#\s*type:\s*ignore|nolint|NOSONAR|\b(?:TODO|FIXME|HACK|XXX)\b/

/** True when the path is generated, vendored, a fixture, legacy, or hidden. */
export function excludedPath(path) {
  const segments = path.split("/")
  const name = segments.at(-1) ?? ""
  return (
    segments.some(
      (s) => s.startsWith(".") || EXCLUDED_SEGMENTS.has(s.toLowerCase()),
    ) || EXCLUDED_NAME.test(name)
  )
}

/** A literal is 3 to 200 characters with no control character. */
export function safeLiteral(text) {
  return (
    typeof text === "string" &&
    text.length >= 3 &&
    text.length <= 200 &&
    // oxlint-disable-next-line no-control-regex -- the check refuses control characters
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)
  )
}

function git(source, args, maxBuffer = 64 * 1024 * 1024, input) {
  return execFileSync(
    "git",
    ["-c", "core.quotepath=off", "-C", source, ...args],
    {
      maxBuffer,
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    },
  )
}

function readFileAtHead(source, path) {
  try {
    return execFileSync("git", ["-C", source, "show", `HEAD:${path}`], {
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    })
  } catch {
    return null
  }
}

/** Changed paths by `source|since|until`; the command line saves it between calls. */
export const changedPathsCache = new Map()

/**
 * The newest MAX_COMMITS commits in [since, until], as a revision range for
 * a history walk: `-S` reads only these commits, not all of the history.
 */
function walkRange(source, since, until) {
  const commits = git(source, [
    "rev-list",
    "--no-merges",
    `--since=${since.toISOString()}`,
    `--until=${until.toISOString()}`,
    `--max-count=${MAX_COMMITS}`,
    "HEAD",
  ])
    .split("\n")
    .filter(Boolean)
  if (commits.length === 0) return null
  return commits
}

/** Paths whose file changed in [since, until], from the default-branch history. */
function changedPaths(source, since, until) {
  const key = `${source}|${since.toISOString()}|${until.toISOString()}`
  const cached = changedPathsCache.get(key)
  if (cached) return new Set(cached)
  const out = git(source, [
    "log",
    "--no-merges",
    "--no-renames",
    "--name-only",
    "--format=",
    `--since=${since.toISOString()}`,
    `--until=${until.toISOString()}`,
    `--max-count=${MAX_COMMITS}`,
    "HEAD",
  ])
  const paths = [...new Set(out.split("\n").filter(Boolean))]
  changedPathsCache.set(key, paths)
  return new Set(paths)
}

/** Added and removed lines with the literal, in one history window. */
function windowCounts(source, literal, since, until) {
  const commits = walkRange(source, since, until)
  if (!commits) return { added: 0, removed: 0 }
  // `--no-walk` reads only the listed commits: at most MAX_COMMITS.
  const out = git(
    source,
    [
      "log",
      "--no-walk=unsorted",
      "--no-renames",
      "-U0",
      "-p",
      "--format=format:@@commit",
      `-S${literal}`,
      "--stdin",
    ],
    MAX_HISTORY_BYTES,
    `${commits.join("\n")}\n`,
  )
  let added = 0
  let removed = 0
  let skip = false
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      skip = excludedPath(line.slice(4).replace(/^b\//, ""))
      continue
    }
    if (line.startsWith("--- ") || skip) continue
    if (line.startsWith("+") && line.includes(literal)) added++
    else if (line.startsWith("-") && line.includes(literal)) removed++
  }
  return { added, removed }
}

/** True when the text has a match of the literal with no suppression or TODO within NEAR_LINES. */
function hasCleanMatch(text, literal) {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(literal)) continue
    const near = lines.slice(Math.max(0, i - NEAR_LINES), i + NEAR_LINES + 1)
    if (!near.some((l) => SUPPRESSION.test(l))) return true
  }
  return false
}

/** At most MAX_EVIDENCE paths, one folder after the other, so they cover the folders. */
function spread(paths) {
  const byFolder = new Map()
  for (const path of paths) {
    const folder = posix.dirname(path)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), path])
  }
  const queues = [...byFolder.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, list]) => list)
  const out = []
  for (let round = 0; out.length < MAX_EVIDENCE; round++) {
    const before = out.length
    for (const queue of queues)
      if (queue[round] && out.length < MAX_EVIDENCE) out.push(queue[round])
    if (out.length === before) break
  }
  return out.sort()
}

/**
 * Measure one literal. `now` is a Date. The older window is the 90 days
 * before the newest 90 days; both lie inside the last 180 days.
 */
export function measurePattern(source, literal, now = new Date()) {
  const result = {
    pattern: literal,
    placement: "none",
    reasons: [],
    files: 0,
    directories: 0,
    evidence: [],
    trend: { older: 0, newest: 0, state: "unknown" },
  }
  if (!safeLiteral(literal)) {
    result.reasons.push("The pattern is not 3 to 200 characters of plain text")
    return result
  }
  let matches
  try {
    matches = git(source, [
      "grep",
      "-z",
      "-l",
      "-F",
      "-I",
      "-e",
      literal,
      "HEAD",
    ])
      .split("\0")
      .filter(Boolean)
      .map((m) => m.replace(/^HEAD:/, ""))
      .sort()
  } catch {
    matches = []
  }
  const middle = new Date(now.getTime() - 90 * DAY_MS)
  const start = new Date(now.getTime() - 180 * DAY_MS)
  let recent = new Set()
  try {
    recent = changedPaths(source, start, now)
  } catch {
    result.reasons.push("The history could not be read")
  }
  const clean = []
  for (const path of matches.slice(0, MAX_FILES)) {
    if (excludedPath(path) || !recent.has(path)) continue
    const text = readFileAtHead(source, path)
    if (text === null) continue
    if (GENERATED_HEADER.test(text.split("\n", 5).join("\n"))) continue
    if (hasCleanMatch(text, literal)) clean.push(path)
  }
  result.files = clean.length
  result.directories = new Set(clean.map((p) => posix.dirname(p))).size
  result.evidence = spread(clean)

  try {
    const older = windowCounts(source, literal, start, middle)
    const newest = windowCounts(source, literal, middle, now)
    result.trend = {
      older: older.added,
      newest: newest.added,
      state:
        newest.added < older.added || newest.removed > newest.added
          ? "falling"
          : "steady",
    }
  } catch {
    result.reasons.push("The history is too large to count the trend")
  }

  const enough =
    result.files >= MIN_FILES && result.directories >= MIN_DIRECTORIES
  if (!enough)
    result.reasons.push(
      `The pattern needs ${MIN_FILES} recent files in ${MIN_DIRECTORIES} folders; it has ${result.files} in ${result.directories}`,
    )
  if (result.trend.state === "falling")
    result.reasons.push(
      "The pattern falls from the older 90 days to the newest",
    )
  if (enough && result.trend.state === "falling")
    result.placement = "being-replaced"
  else if (enough && result.trend.state === "steady") result.placement = "rules"
  return result
}

/** Paths that exist in the checkout at HEAD, from the arguments. */
function main() {
  const argv = process.argv.slice(2)
  const patterns = []
  let source = null
  // The end of today (UTC), so that the calls of a step share the cache.
  let now = new Date(Math.ceil(Date.now() / DAY_MS) * DAY_MS)
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]
    if (value === undefined) {
      process.stderr.write(`Give a value after ${argv[i]}\n`)
      process.exit(1)
    }
    if (argv[i] === "--source") source = value
    else if (argv[i] === "--now") now = new Date(value)
    else if (argv[i] === "--pattern") patterns.push(value)
    else {
      process.stderr.write(`Unknown argument ${argv[i]}\n`)
      process.exit(1)
    }
  }
  if (!source || patterns.length === 0 || Number.isNaN(now.getTime())) {
    process.stderr.write(
      "Usage: patterns.mjs --source <checkout> [--now <ISO date>] --pattern <literal>...\n",
    )
    process.exit(1)
  }
  // The state of this step: the count of calls and the changed paths. The
  // sandbox of a step has its own temporary folder.
  const statePath = join(
    tmpdir(),
    `ctxpipe-patterns-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.json`,
  )
  let state = { calls: 0, changed: {} }
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    // No call in this step yet.
  }
  if (state.calls >= MAX_CALLS_PER_STEP) {
    process.stderr.write(
      `This step already ran patterns.mjs ${MAX_CALLS_PER_STEP} times. Use the results that you have.\n`,
    )
    process.exit(2)
  }
  for (const [key, paths] of Object.entries(state.changed ?? {}))
    changedPathsCache.set(key, paths)
  const results = patterns
    .slice(0, MAX_PATTERNS_PER_CALL)
    .map((literal) => measurePattern(source, literal, now))
  writeFileSync(
    statePath,
    JSON.stringify({
      calls: state.calls + 1,
      changed: Object.fromEntries(changedPathsCache),
    }),
  )
  process.stdout.write(`${JSON.stringify({ patterns: results })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
