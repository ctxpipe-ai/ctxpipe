#!/usr/bin/env node
// decisions: a repository-wide step on the assembled ref, after the root
// steps. The script finds the decision files (ADRs) of the source repository
// and reads what a script can read: title, number, declared status, date,
// declared supersession, and scope. It gives the agent one entry for each
// decision file, with the path of the context file to write and the claims
// that scripts found. The agent reads each decision file and writes the
// context file. No script writes a file.
//
// node decisions.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> [--check]
//
// Paging (ADR-052 section 6): a page is the first 20 decision files, in the
// run order, whose context file this run has not written yet at the step
// base. The host runs the skill again on the new tip while `more` is true,
// so the script computes the page again from the tip; there is no offset.
//
// Without --check, the script prints the entries of one page (20 decision
// files) to stdout. With --check, it compares the staged tree in
// <root>/out/files with the entries and prints the problems; it exits with 1
// when there are problems.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { posix } from "node:path"
import { nameKey, relativeTo, scriptStep } from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  readDeletes,
  stagedFile,
  stagedPaths,
} from "../../bin/stage-lib.mjs"
import {
  readTracked,
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import {
  extractRefs,
  parseDecision,
  referencedPaths,
} from "./decision-parse.mjs"

const PAGE_SIZE = 20
const MAX_FILES = 300
const MAX_TARGETS = 15
const MAX_RELATED = 10
const MAX_CLAUSE_EDGES = 10
const MAX_STALE = 10
const MAX_SKIPPED = 30

/** Folders whose Markdown files are decision files. */
const DECISION_FOLDERS = new Set([
  "adr",
  "adrs",
  "decisions",
  "decision-records",
  "architecture-decisions",
  "architecture-decision-records",
])
/** Folders that never hold a decision file of the source. */
const IGNORED_FOLDERS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "testdata",
  "fixtures",
  "__fixtures__",
  ".ctxpipe",
  ".agents",
  ".claude",
  ".cursor",
  ".opencode",
])
/** Folder names that carry no meaning in the name of the context file. */
const GENERIC_FOLDERS = new Set([
  ...DECISION_FOLDERS,
  "docs",
  "doc",
  "documentation",
  "architecture",
  "design",
])

/** True for a Markdown file in a decision folder, or with an `adr-<number>` name. */
function isDecisionFile(path) {
  if (!/\.(md|markdown)$/i.test(path)) return false
  const segments = path.split("/")
  const base = segments.pop()
  if (segments.some((s) => IGNORED_FOLDERS.has(s.toLowerCase()))) return false
  if (
    /^(readme|index|_index|summary|toc)\b/i.test(base) ||
    /template/i.test(base)
  )
    return false
  return (
    segments.some((s) => DECISION_FOLDERS.has(s.toLowerCase())) ||
    /^adr[-_ ]?\d{1,6}\b/i.test(base)
  )
}

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 8)

/** `knowledge/decisions/<owner>-<repository>-<path>.md`, with no folder name that says nothing. */
function targetPath(repository, path) {
  const segments = path
    .replace(/\.(md|markdown)$/i, "")
    .split("/")
    .filter((s) => !GENERIC_FOLDERS.has(s.toLowerCase()))
  let name = slug(`${repository.replace("/", "-")}-${segments.join("-")}`)
  if (name.length > 100)
    name = `${name.slice(0, 90).replace(/-+$/, "")}-${hash(path)}`
  return `knowledge/decisions/${name}.md`
}

const STATUS_LABEL = {
  accepted: "Accepted",
  proposed: "Proposed",
  draft: "Draft",
  deprecated: "Deprecated",
  superseded: "Superseded",
  rejected: "Rejected",
  undeclared: "Undeclared",
}

const { step, source, repository, roots, index, skipped } = scriptStep()
const check = process.argv.slice(2).includes("--check")

const tracked = trackedFiles(source)
const trackedSet = new Set(tracked)
const folders = new Set()
for (const path of tracked) {
  let at = path.lastIndexOf("/")
  while (at > 0) {
    const dir = path.slice(0, at)
    if (folders.has(dir)) break
    folders.add(dir)
    at = dir.lastIndexOf("/")
  }
}
const exists = (path) => trackedSet.has(path) || folders.has(path)

// 1. The decision files.
let found = tracked.filter(isDecisionFile).sort()
if (found.some((p) => !safePath(p)))
  skipped.push({
    path: null,
    reason:
      "A decision file path has characters that the script does not quote",
  })
found = found.filter(safePath)
if (found.length > MAX_FILES) {
  skipped.push({
    path: null,
    reason: `The script read only the first ${MAX_FILES} of ${found.length} decision files`,
  })
  found = found.slice(0, MAX_FILES)
}

const candidates = []
for (const path of found) {
  const text = readTracked(source, path)
  if (!text.trim()) {
    skipped.push({
      path,
      reason: "The file is empty, missing, or larger than 1 MiB",
    })
    continue
  }
  const dir = posix.dirname(path) === "." ? "." : posix.dirname(path)
  candidates.push({ path, dir, text, ...parseDecision(path, text) })
}
const byPath = new Map(candidates.map((c) => [c.path, c]))
const byNumber = new Map()
for (const c of candidates)
  if (c.number !== null)
    byNumber.set(c.number, [...(byNumber.get(c.number) ?? []), c])

// 2. Declared supersession, only between decision files of this source.
const edges = new Map() // "from>to" -> { from, to, evidence }
for (const c of candidates) {
  let count = 0
  for (const clause of c.clauses) {
    const refs = extractRefs(clause.text, c.dir)
    const hits = new Set()
    for (const p of refs.paths) {
      const target = byPath.get(p)
      if (target && target !== c) hits.add(target)
    }
    for (const n of refs.numbers) {
      const same = (byNumber.get(n) ?? []).filter((t) => t !== c)
      const near = same.filter((t) => t.dir === c.dir)
      const pick =
        near.length === 1
          ? near[0]
          : near.length === 0 && same.length === 1
            ? same[0]
            : null
      if (pick) hits.add(pick)
    }
    for (const hit of hits) {
      if (count++ >= MAX_CLAUSE_EDGES) break
      const [from, to] = clause.kind === "supersedes" ? [c, hit] : [hit, c]
      edges.set(`${from.path}>${to.path}`, { from, to, evidence: c.path })
    }
  }
}
// A decision cannot replace one that replaces it, so drop both edges.
const mutual = [...edges].filter(([, edge]) =>
  edges.has(`${edge.to.path}>${edge.from.path}`),
)
for (const [key, edge] of mutual) {
  edges.delete(key)
  skipped.push({
    path: edge.from.path,
    reason: `The files ${edge.from.path} and ${edge.to.path} each say that they replace the other, so the script keeps neither claim`,
  })
}
// Write the replaced decision before the one that replaces it, so that each
// SUPERSEDES target exists at the step base (links resolve in the validator).
const order = []
{
  const placed = new Set()
  const sorted = [...candidates].sort((a, b) => (a.path < b.path ? -1 : 1))
  const deps = new Map()
  for (const e of edges.values())
    deps.set(e.from, [...(deps.get(e.from) ?? []), e.to])
  const needs = (c) => deps.get(c) ?? []
  while (placed.size < sorted.length) {
    const next = sorted.find(
      (c) => !placed.has(c) && needs(c).every((t) => placed.has(t)),
    )
    if (!next) {
      // A longer cycle: keep the files, drop the edges between them.
      const rest = sorted.filter((c) => !placed.has(c))
      for (const [key, edge] of [...edges])
        if (rest.includes(edge.from) && rest.includes(edge.to)) {
          edges.delete(key)
          skipped.push({
            path: edge.from.path,
            reason:
              "The files form a replacement cycle, so the script keeps no claim between them",
          })
        }
      for (const c of rest) {
        placed.add(c)
        order.push(c)
      }
      break
    }
    placed.add(next)
    order.push(next)
  }
}
for (const c of candidates)
  c.replacedBy = [...edges.values()].filter((e) => e.to === c)

// 3. Scope: the narrowest signal. A package alone scopes a decision, unless
//    the package is the repository root. Else the roots that the text names.
//    Else every Service of the repository. Only Service files get a claim.
const codeRoots = roots
  .filter((r) => r.path !== ".")
  .sort((a, b) => b.path.length - a.path.length)
const rootOf = (path) =>
  codeRoots.find((r) => path === r.path || path.startsWith(`${r.path}/`)) ??
  null
const decisionPaths = new Set(candidates.map((c) => c.path))
for (const c of candidates) {
  const own = rootOf(c.path)
  let basis = "repository"
  let scoped = roots
  if (own) {
    basis = "package"
    scoped = [own]
  } else {
    const named = new Set()
    for (const p of referencedPaths(c.text, c.dir, exists)) {
      if (p === c.path || decisionPaths.has(p)) continue
      const hit = rootOf(p)
      if (hit) named.add(hit)
    }
    if (named.size) {
      basis = "reference"
      scoped = [...named].sort((a, b) => (a.path < b.path ? -1 : 1))
    }
  }
  const files = scoped.flatMap((r) => r.files)
  const services = files.filter((f) => f.kind === "Service").map((f) => f.path)
  c.scope = {
    basis,
    roots: scoped.map((r) => r.path).slice(0, MAX_TARGETS),
    services: [...new Set(services)].sort(),
    related:
      basis === "repository"
        ? []
        : [...new Set(files.map((f) => f.path))].sort(),
  }
  delete c.text
}

// 4. The context file of each decision: an existing file that describes the
//    same decision, else a new file at a path that the source path decides.
const decisionEntries = index.filter(
  (e) => e.kind === "Decision" && typeof e.path === "string",
)
const entryAt = new Map(decisionEntries.map((e) => [e.path, e]))
const taken = new Map()
for (const c of order) {
  c.name = c.number === null ? c.title : `ADR-${c.number}: ${c.title}`
  const derived = targetPath(repository, c.path)
  const keys = new Set([nameKey(c.title), nameKey(c.name)])
  const sole = (e) =>
    e.owned === true && Array.isArray(e.sources) && e.sources.length === 1
  const matches = decisionEntries
    .filter((e) => e.path === derived || keys.has(nameKey(e.title)))
    .filter((e) => !taken.has(e.path))
    .sort(
      (a, b) => Number(sole(b)) - Number(sole(a)) || (a.path < b.path ? -1 : 1),
    )
  let target = derived
  let write = "create"
  const match =
    entryAt.get(derived) && !taken.has(derived)
      ? entryAt.get(derived)
      : matches[0]
  if (match) {
    target = match.path
    write = sole(match) ? "update" : "additive"
  } else if (taken.has(derived) || trackedBlob(derived)) {
    // A file at the path that the index does not show: do not replace it.
    target = taken.has(derived)
      ? `${derived.slice(0, -3)}-${hash(c.path)}.md`
      : derived
    write = taken.has(derived) ? "create" : "additive"
  }
  taken.set(target, c)
  c.target = target
  c.write = write
  c.existing = write === "create" ? null : target
}

function trackedBlob(path) {
  try {
    return baseBlob(step, path) !== null
  } catch {
    return false
  }
}

// 5. Files that this source wrote for a decision file that has left the source.
function stale() {
  const out = []
  for (const e of decisionEntries) {
    if (taken.has(e.path) || e.owned !== true || e.sources?.length !== 1)
      continue
    const blob = baseBlob(step, e.path)
    if (!blob) continue
    const text = blobContent(step, blob).toString("utf8")
    const line = /^\*\*Source:\*\*\s*`([^`\n]{1,300})`/m.exec(text)?.[1]
    // A file with no Source line is not one that this skill wrote; leave it.
    if (line && safePath(line) && !trackedSet.has(line)) out.push(e.path)
  }
  return out.sort()
}

/** The run's SHA: the source checkout is at it. */
const runSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"])
  .toString("utf8")
  .trim()

/**
 * True when an earlier page of this run wrote the context file of `c`: the
 * file names the decision file, and a full write has the run's `source_sha`.
 */
function done(c) {
  let blob = null
  try {
    blob = baseBlob(step, c.target)
  } catch {
    return false
  }
  if (!blob) return false
  const text = blobContent(step, blob).toString("utf8")
  if (!text.includes(`\`${c.path}\``)) return false
  if (c.write === "additive") return true
  return new RegExp(`^source_sha: ["']?${runSha}["']?$`, "m").test(text)
}

const waiting = order.filter((c) => !done(c))
const page = waiting.slice(0, PAGE_SIZE)
const more = waiting.length > PAGE_SIZE

function entryOf(c) {
  const rel = (path) => relativeTo(c.target, path)
  return {
    path: c.path,
    name: c.name,
    title: c.title,
    number: c.number,
    status: c.replacedBy.length ? "superseded" : c.status,
    statusText: c.statusText,
    date: c.date,
    target: c.target,
    write: c.write,
    existing: c.existing,
    scope: {
      basis: c.scope.basis,
      roots: c.scope.roots,
      truncated: c.scope.services.length > MAX_TARGETS,
    },
    influences: c.scope.services.slice(0, MAX_TARGETS).map(rel),
    supersedes: [...edges.values()]
      .filter((e) => e.from === c)
      .map((e) => ({ to: rel(e.to.target), evidence: e.evidence })),
    related: c.scope.related.slice(0, MAX_RELATED).map(rel),
  }
}

if (!check) {
  const staleFiles = !more && skipped.length === 0 ? stale() : []
  const result = {
    repository,
    total: order.length,
    done: order.length - waiting.length,
    more,
    decisions: page.map(entryOf),
    stale: staleFiles.slice(0, MAX_STALE),
    skipped: skipped.slice(0, MAX_SKIPPED),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(0)
}

// --check: compare the staged tree with the entries.
const problems = []
const problem = (path, text) => problems.push({ path, problem: text })
const entries = new Map(page.map((c) => [c.target, entryOf(c)]))
const staleSet = new Set(stale())
const staged = stagedPaths(step).filter((p) =>
  p.startsWith("knowledge/decisions/"),
)
for (const path of Object.keys(readDeletes(step)))
  if (!staleSet.has(path))
    problem(
      path,
      "The file is not a decision file of the source that has left it",
    )
const unquote = (text) => {
  const t = text.trim()
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t)
    } catch {
      return t
    }
  }
  return t.replace(/^'(.*)'$/, "$1")
}
for (const path of staged) {
  const entry = entries.get(path)
  if (!entry) {
    problem(
      path,
      "No decision file of this page has this context path. Update the existing file that describes the decision, and add no new file",
    )
    continue
  }
  const text = readFileSync(stagedFile(step, path), "utf8")
  const front = /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!front) {
    problem(path, "The file has no front matter")
    continue
  }
  const claims = new Set()
  let to = null
  for (const line of front[1].split("\n")) {
    const toLine = /^\s*-?\s*to:(.*)$/.exec(line)
    if (toLine) to = unquote(toLine[1])
    const predicate = /^\s*predicate:\s*["']?([A-Z0-9_]+)["']?\s*$/.exec(line)
    if (predicate && to !== null)
      claims.add(
        `${predicate[1]} ${posix.normalize(posix.join(posix.dirname(path), to))}`,
      )
  }
  const resolve = (rel) => posix.normalize(posix.join(posix.dirname(path), rel))
  const wanted = [
    ...entry.influences.map((rel) => `INFLUENCES ${resolve(rel)}`),
    ...entry.supersedes.map((s) => `SUPERSEDES ${resolve(s.to)}`),
  ]
  for (const claim of wanted)
    if (!claims.has(claim))
      problem(path, `The claim is missing: ${claim.replace(" ", " to ")}`)
  for (const claim of claims)
    if (/^(INFLUENCES|SUPERSEDES) /.test(claim) && !wanted.includes(claim))
      problem(
        path,
        `The script did not find this claim, so do not add it: ${claim.replace(" ", " to ")}`,
      )
  if (entry.write !== "additive") {
    const name = /^name:(.*)$/m.exec(front[1])
    if (!name || unquote(name[1]) !== entry.name)
      problem(path, `The name must be ${JSON.stringify(entry.name)}`)
    const status = /^\*\*Status:\*\*\s*(\S+)/m.exec(
      text.slice(front[0].length),
    )?.[1]
    if (
      status?.toLowerCase().replace(/[^a-z]/g, "") !==
      STATUS_LABEL[entry.status].toLowerCase()
    )
      problem(path, `The Status line must say ${STATUS_LABEL[entry.status]}`)
  }
}
for (const [path, entry] of entries)
  if (!staged.includes(path))
    problem(path, `The decision file ${entry.path} has no context file yet`)
process.stdout.write(
  `${JSON.stringify({ checked: staged.length, problems })}\n`,
)
process.exit(problems.length ? 1 : 0)
