#!/usr/bin/env node
// decisions: a repository-wide step on the assembled ref, after the root
// steps. The script finds the decision files (ADRs) of the source repository
// and reads what a script can read: title, number, declared status, date,
// declared supersession, and scope. It gives the agent one entry for each
// decision file, with the path of the context file to write and the claims
// that scripts found. The agent reads each decision file and writes the
// context file. No script writes a context file; each run of this script
// writes the cursor to patch.json.
//
// node decisions.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> [--check | --count]
//
// Paging (ADR-052 section 6): a page lists each decision file, in the run
// order, whose context file this run has not written yet at the step base.
// A page has no file count: it ends at the step limits of the validator or
// at the step checkpoint. The host runs the skill again on the new tip while
// `more` is true, so the script computes the page again from the tip; there
// is no offset.
//
// The cursor (CTX-1487): with --count, the script prints `{"count": <n>}`,
// the decision files of the run order, and writes nothing. The other runs
// write `cursor.at` in patch.json: the decision files that are done at the
// step base, and the entries of this page whose context file is staged and
// has no problem.
//
// Without --check, the script prints the entries of the page to stdout.
// With --check, it compares the staged tree in <root>/out/files with the
// entries and prints the problems and the count of the entries that wait;
// it exits with 1 when there are problems.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { posix } from "node:path"

import { nameKey, relativeTo, scriptStep } from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  listBaseTree,
  readBaseBlobs,
  readDeletes,
  stagedFile,
  outputBudget,
  stagedPaths,
  STEP_LIMITS,
  writePatch,
} from "../../bin/stage-lib.mjs"
import {
  inTestFixture,
  readTrackedMany,
  safePath,
  testFixtureSkips,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import {
  decisionForm,
  decisionKey,
  extractRefs,
  FORM_LABEL,
  GENERIC_FOLDERS,
  parseDecision,
  referencedPaths,
} from "./decision-parse.mjs"

// No count limit on decision files, scope targets, Related lines,
// supersession edges, or stale files (CTX-1487): the cursor pages over the
// decision files. The list of a run ends at the size limit of
// `outputBudget` so that the model can read it, and says how many entries
// wait. `skipped` is a report, not input: it lists MAX_SKIPPED entries and
// the count of the others.
const MAX_SKIPPED = 30

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 8)

/**
 * `knowledge/decisions/<owner>-<repository>-<path>.md`, with no folder name
 * that says nothing. A KEP README takes the path of its folder.
 */
function targetPath(repository, path) {
  const segments = path
    .replace(/(?:^|\/)readme\.(md|markdown)$/i, "")
    .replace(/\.(md|markdown|rst|txt)$/i, "")
    .split("/")
    .filter((s) => !GENERIC_FOLDERS.has(s.toLowerCase()))
  let name = slug(`${repository.replace("/", "-")}-${segments.join("-")}`)
  if (name.length > 100)
    name = `${name.slice(0, 90).replace(/-+$/, "")}-${hash(path)}`
  return `knowledge/decisions/${name}.md`
}

/** The Status line of a status: its first letter in capitals (`implementable` is `Implementable`). */
const statusLabel = (status) => status.charAt(0).toUpperCase() + status.slice(1)

const { step, source, repository, roots, index, skipped } = scriptStep()
// The script checks the base path of each decision file: one git call.
listBaseTree(step)
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

// 1. The decision files: design records in each form of `decisionForm`.
const trackedFile = (path) => trackedSet.has(path)
const forms = new Map()
const fixtures = []
for (const path of tracked) {
  const form = decisionForm(path, trackedFile)
  if (form && inTestFixture(path)) fixtures.push(path)
  else if (form) forms.set(path, form)
}
// A copy in a test fixture folder is not a decision of the source, so its
// entry does not stop the delete of stale files below.
const fixtureSkipped = testFixtureSkips(fixtures).map(({ path, reason }) => ({
  path,
  reason,
}))
let found = [...forms.keys()].sort()
if (found.some((p) => !safePath(p)))
  skipped.push({
    path: null,
    reason:
      "A decision file path has characters that the script does not quote",
  })
found = found.filter(safePath)

// One batch of git calls reads each decision file and each metadata file.
const texts = readTrackedMany(
  source,
  [
    ...new Set(
      found.flatMap((path) => [path, forms.get(path).meta ?? []]).flat(),
    ),
  ],
  (text) => text,
)
const candidates = []
for (const path of found) {
  const text = texts.get(path)
  if (!text.trim()) {
    skipped.push({
      path,
      reason: "The file is empty, missing, or larger than 1 MiB",
    })
    continue
  }
  const dir = posix.dirname(path) === "." ? "." : posix.dirname(path)
  const form = forms.get(path)
  const meta = form.meta === null ? null : texts.get(form.meta)
  candidates.push({
    path,
    dir,
    text,
    merged: form.merged,
    ...parseDecision(path, text, form, meta),
  })
}
const byPath = new Map(candidates.map((c) => [c.path, c]))
const byNumber = new Map()
for (const c of candidates)
  if (c.number !== null) {
    const key = decisionKey(c.form, c.number)
    byNumber.set(key, [...(byNumber.get(key) ?? []), c])
  }
/** The decision file at a referenced path: the file, or the README of a KEP folder. */
const decisionAt = (path) =>
  byPath.get(path) ?? byPath.get(`${path.replace(/\/+$/, "")}/README.md`)

// 2. Declared supersession, only between decision files of this source.
const edges = new Map() // "from>to" -> { from, to, evidence }
for (const c of candidates) {
  for (const clause of c.clauses) {
    const refs = extractRefs(clause, {
      dir: c.dir,
      form: c.form,
      merged: c.merged,
      repository,
    })
    const hits = new Set()
    for (const p of refs.paths) {
      const target = decisionAt(p)
      if (target && target !== c) hits.add(target)
    }
    for (const key of refs.keys) {
      const same = (byNumber.get(key) ?? []).filter((t) => t !== c)
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

// The finder of the cursor (CTX-1487): the run order is the input.
if (process.argv.slice(2).includes("--count")) {
  process.stdout.write(`${JSON.stringify({ count: order.length })}\n`)
  process.exit(0)
}

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
    roots: scoped.map((r) => r.path),
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
  const label = FORM_LABEL[c.form]
  c.name =
    c.number === null || !label ? c.title : `${label}-${c.number}: ${c.title}`
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

readBaseBlobs(
  step,
  order.map((c) => c.target),
)
const waiting = order.filter((c) => !done(c))

function entryOf(c) {
  const rel = (path) => relativeTo(c.target, path)
  return {
    path: c.path,
    metadata: forms.get(c.path).meta,
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
    },
    influences: c.scope.services.map(rel),
    supersedes: [...edges.values()]
      .filter((e) => e.from === c)
      .map((e) => ({ to: rel(e.to.target), evidence: e.evidence })),
    related: c.scope.related.map(rel),
  }
}

// The staged tree and its problems.
const problems = []
const problem = (path, text) => problems.push({ path, problem: text })
const entries = new Map(waiting.map((c) => [c.target, entryOf(c)]))
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
// The step limits of the validator, in its order: a file of at most
// 64 KiB, and at most 2 MiB of staged files.
{
  let total = 0
  for (const path of stagedPaths(step)) {
    const size = statSync(stagedFile(step, path)).size
    if (size > STEP_LIMITS.fileBytes)
      problem(
        path,
        `The file is larger than ${STEP_LIMITS.fileBytes / 1024} KiB. Make it shorter`,
      )
    else if (total + size > STEP_LIMITS.stagedBytes)
      problem(
        path,
        `The staged tree is larger than ${STEP_LIMITS.stagedBytes / 1024 / 1024} MiB. Remove this file from /ctxpipe/out/files: it waits for the next page. Then run ctxpipe-finish --more`,
      )
    else total += size
  }
}
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
    if (status?.toLowerCase().replace(/[^a-z]/g, "") !== entry.status)
      problem(path, `The Status line must say ${statusLabel(entry.status)}`)
  }
}

// The cursor: the decision files done at the step base, and the entries of
// this page whose context file is staged and has no problem.
const flagged = new Set(problems.map((p) => p.path))
const written = waiting.filter(
  (c) => staged.includes(c.target) && !flagged.has(c.target),
)
writePatch(step, {
  cursor: { at: order.length - waiting.length + written.length },
})

// The exit code and no process.exit: a page can be larger than the pipe
// buffer, and process.exit can cut the output.
if (!check) {
  // The entries that wait: no context file at the step base, and none in
  // the staged tree with no problem. In the run order, up to the size limit.
  const open = waiting.filter((c) => !written.includes(c))
  const budget = outputBudget()
  const decisions = open.map(entryOf).filter(budget.take)
  const report = [...skipped, ...fixtureSkipped]
  const result = {
    repository,
    total: order.length,
    done: order.length - waiting.length,
    waiting: open.length,
    more: budget.more(),
    decisions,
    stale: skipped.length === 0 ? [...staleSet] : [],
    skipped: [
      ...report.slice(0, MAX_SKIPPED),
      ...(report.length > MAX_SKIPPED
        ? [
            {
              path: null,
              reason: `${report.length - MAX_SKIPPED} more entries are not listed`,
            },
          ]
        : []),
    ],
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} else {
  process.stdout.write(
    `${JSON.stringify({
      checked: staged.length,
      waiting: waiting.filter((c) => !staged.includes(c.target)).length,
      problems,
    })}\n`,
  )
  process.exitCode = problems.length ? 1 : 0
}
