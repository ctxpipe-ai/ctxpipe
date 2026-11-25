#!/usr/bin/env node
// instruction-areas: turn the agent's proposal into shared area files. The
// agent reads the documents and the code and writes a proposal of candidate
// rules. This script decides, with no model: which rules the good-practice
// rules allow (concept section 5.4), whether the practice is the same as or
// different from an existing area file (5.2), and how the source joins or
// leaves a shared file (5.3). It then writes the staged tree and
// /ctxpipe/out/patch.json, and a FOLLOWS claim from the codebase file of the
// source to each area file.
//
// node instruction-areas.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> --proposal <file> [--now <ISO date>]
//
// The skill pages by a cursor over the documents of documents.mjs
// (CTX-1570). The first page writes the areas of the source again: the
// source leaves each area file that it lists, and then joins the areas of
// the proposal. Thus after the first page, each area file that lists the
// source is a file of this run, and a later page adds to it: the rules and
// notes of the earlier pages stay. patch.json gets the cursor after the
// documents of the page that the proposal is done with (`done`, in list
// order), and `more` while documents wait. An area file takes what fits in
// the host format and in 63 KiB, and the step stages at most what fits in
// 2 MiB; each rule, note, or file that does not fit gets a `skipped` entry.
//
// The proposal and the source repository are hostile. Text from the proposal
// is cleaned (no backtick, control character, or markup), each quote of a
// document is looked up in the file, and each pattern is counted by
// patterns.mjs. The host validator checks the result again.

import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { relativeTo, scriptStep, writeStep } from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  ensureParent,
  removeStaged,
  STEP_LIMITS,
  stagedFile,
  stagedPaths,
  writeDeletes,
} from "../../bin/stage-lib.mjs"
import { readTracked } from "../../discover-roots/scripts/roots-lib.mjs"
import {
  cleanText,
  compareRules,
  MAX_NOTES,
  MAX_RULES,
  MIN_NEW_AREA_RULES,
  newFront,
  normalizeSource,
  parseAreaFile,
  renderAreaFile,
  SEED_AREAS,
  SEED_SLUGS,
  slugify,
} from "./areas-lib.mjs"
import { documentPage, selectDocuments } from "./documents.mjs"
import { measurePattern } from "./patterns.mjs"

const { step, source, roots, index, skipped, value, ...given } = scriptStep()
const sourceId = given.sourcePath.trim()
const now = value("--now") ? new Date(value("--now")) : new Date()
const proposalFile = value("--proposal")
if (!proposalFile || Number.isNaN(now.getTime())) {
  process.stderr.write("Give --proposal <file> and a valid --now\n")
  process.exit(1)
}
const skip = (path, reason) => skipped.push({ path, reason })

let proposal
try {
  const text = readFileSync(proposalFile, "utf8")
  if (text.length > 1024 * 1024) throw new Error("too large")
  proposal = JSON.parse(text)
} catch {
  process.stderr.write("The proposal is not a JSON file of at most 1 MiB\n")
  process.exit(1)
}
const proposed = Array.isArray(proposal?.areas) ? proposal.areas : []
// The documents of this page, as documents.mjs lists them.
const documents = selectDocuments(
  source,
  roots.map((r) => r.path),
).documents
const page = documentPage(documents, step.cursorAt)
const done = new Set(Array.isArray(proposal?.done) ? proposal.done : [])
let cursorAt = page.from
while (cursorAt < page.to && done.has(documents[cursorAt].path)) cursorAt++
const laterPage = page.from > 0

// ---- the rules of one area --------------------------------------------------

const KEY = /^[a-z0-9][a-z0-9-]{0,59}$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A shorter quote, for example "the", is in almost every file, so it proves nothing. */
const MIN_QUOTE_LENGTH = 20

/** Paths of the documents whose quote is in the file, at most 5. */
function documentEvidence(documents) {
  const paths = []
  for (const doc of Array.isArray(documents) ? documents.slice(0, 5) : []) {
    const quote = doc?.quote
    if (
      typeof doc?.path !== "string" ||
      typeof quote !== "string" ||
      quote.length < MIN_QUOTE_LENGTH ||
      quote.length > 300 ||
      quote.includes("\n")
    )
      continue
    if (
      readTracked(source, doc.path).includes(quote) &&
      !paths.includes(doc.path)
    )
      paths.push(doc.path)
  }
  return paths
}

/** The rules that the good-practice rules allow, the notes, and what was dropped. */
function evaluate(area) {
  const kept = []
  const drift = []
  for (const raw of Array.isArray(area.rules) ? area.rules : []) {
    const key =
      typeof raw?.key === "string" && KEY.test(raw.key) ? raw.key : null
    const val = cleanText(raw?.value, 100)
    const text = cleanText(raw?.text, 300)
    if (!key || !val || !text) {
      skip(null, `A rule of ${area.slug} has no valid key, value, or text`)
      continue
    }
    const rule = { key, value: val, text, core: raw.core === true }
    const docs = documentEvidence(raw.documents)
    if (docs.length) {
      kept.push({
        ...rule,
        basis: "documented",
        evidence: docs,
        section: "rules",
      })
      continue
    }
    if (typeof raw.pattern !== "string" || raw.pattern.includes("`")) {
      skip(
        null,
        `The rule ${key} of ${area.slug} has no verified document and no pattern without a backtick`,
      )
      continue
    }
    const measured = measurePattern(source, raw.pattern, now)
    if (measured.placement === "none") {
      skip(
        null,
        `The rule ${key} of ${area.slug} was not inferred: ${measured.reasons.join("; ")}`,
      )
      continue
    }
    kept.push({
      ...rule,
      basis: "inferred",
      pattern: raw.pattern,
      evidence: measured.evidence,
      section: measured.placement === "rules" ? "rules" : "replaced",
    })
  }
  // One rule for each key; a document wins over code (concept 5.4, point 5).
  const byKey = new Map()
  for (const rule of kept) {
    const known = byKey.get(rule.key)
    if (!known) byKey.set(rule.key, rule)
    else if (known.basis === "inferred" && rule.basis === "documented") {
      if (known.value !== rule.value)
        drift.push(
          `Code in \`${known.evidence[0]}\` uses \`${known.value}\` for \`${known.key}\`, but a document says \`${rule.value}\`. The document wins.`,
        )
      byKey.set(rule.key, rule)
    } else {
      if (
        rule.basis === "inferred" &&
        known.basis === "documented" &&
        known.value !== rule.value
      )
        drift.push(
          `Code in \`${rule.evidence[0]}\` uses \`${rule.value}\` for \`${rule.key}\`, but a document says \`${known.value}\`. The document wins.`,
        )
      skip(
        null,
        `The rule ${rule.key} of ${area.slug} came twice; the script kept the first or the documented one`,
      )
    }
  }
  const notes = (Array.isArray(area.notes) ? area.notes : [])
    .map((n) => cleanText(n, 300))
    .filter(Boolean)
  return { rules: [...byKey.values()], notes: [...notes, ...drift] }
}

// ---- files of the context repository ----------------------------------------

function contextGit(args) {
  return execFileSync("git", ["-C", step.contextDir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8")
}

const existingNames = contextGit([
  "ls-tree",
  "--name-only",
  "-z",
  step.baseCommit,
  "knowledge/instructions/",
])
  .split("\0")
  .filter((p) =>
    /^knowledge\/instructions\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(p),
  )
  .map((p) => p.slice("knowledge/instructions/".length, -3))
  .sort()

const parsedCache = new Map()
function readAreaFile(name) {
  const path = `knowledge/instructions/${name}.md`
  if (!parsedCache.has(path)) {
    const blob = baseBlob(step, path)
    const parsed = blob
      ? parseAreaFile(blobContent(step, blob).toString("utf8"))
      : { error: "missing" }
    parsedCache.set(path, { path, ...parsed })
  }
  return parsedCache.get(path)
}

function familyOf(slug) {
  return existingNames.filter(
    (n) =>
      (n === slug || n.startsWith(`${slug}-`)) &&
      ![...SEED_SLUGS].some(
        (s) =>
          s.length > slug.length &&
          s.startsWith(`${slug}-`) &&
          (n === s || n.startsWith(`${s}-`)),
      ),
  )
}

// ---- change one area file ---------------------------------------------------

const outputs = new Map() // path -> text
const deletes = new Map() // path -> reason
const report = []

const toEvidence = (rule) => ({
  basis: rule.basis,
  paths: rule.evidence,
  ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }),
})

/** The file's rules and notes without this source, and without a rule that has no evidence left. */
function withoutSource(parsed) {
  const rules = []
  for (const rule of parsed.area.rules) {
    const own = new Map(rule.sources)
    own.delete(sourceId)
    if (own.size) rules.push({ ...rule, sources: own })
  }
  return {
    rules,
    notes: parsed.area.notes.filter((n) => n.source !== sourceId),
  }
}

/** The source leaves a file: its evidence and notes go; the file goes when it was the last source. */
function leave(parsed) {
  const rest = withoutSource(parsed)
  if (parsed.sources.every((s) => s === sourceId)) {
    if (parsed.human.length)
      skip(parsed.path, "The file has a human section, so the script keeps it")
    else deletes.set(parsed.path, "The source no longer follows this area")
    return
  }
  outputs.set(
    parsed.path,
    renderAreaFile(parsed.front, { ...parsed.area, ...rest }, parsed.human),
  )
}

/**
 * Join, update, or make a file. On a later page, the rules and notes of the
 * source from the earlier pages stay. A rule or a note that the file cannot
 * take (60 rules, 100 notes, 63 KiB with the host fields) gets a `skipped`
 * entry; the rules and notes that the file had stay.
 */
function mergeInto(parsed, area) {
  const rest = laterPage
    ? {
        rules: parsed.area.rules.map((r) => ({
          ...r,
          sources: new Map(r.sources),
        })),
        notes: parsed.area.notes,
      }
    : withoutSource(parsed)
  const rules = rest.rules
  const notes = [...rest.notes]
  const added = [] // the new rules and notes, in the order of the file
  const leftOut = (limit, what) =>
    skip(
      parsed.path,
      `The area file holds at most ${limit}, so ${what} was left out`,
    )
  const addNote = (text) => {
    if (notes.some((n) => n.source === sourceId && n.text === text)) return
    if (notes.length >= MAX_NOTES)
      return leftOut(`${MAX_NOTES} notes`, `a note of ${sourceId}`)
    const note = { source: sourceId, text }
    notes.push(note)
    added.push({ note })
  }
  for (const text of area.notes) addNote(text)
  for (const rule of [...area.rules].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const known = rules.find((r) => r.key === rule.key)
    if (!known && rules.length >= MAX_RULES) {
      leftOut(`${MAX_RULES} rules`, `the rule ${rule.key}`)
    } else if (!known) {
      const shared = {
        section: rule.section,
        key: rule.key,
        value: rule.value,
        core: rule.core,
        text: rule.text,
        sources: new Map([[sourceId, toEvidence(rule)]]),
      }
      rules.push(shared)
      added.push({ rule: shared })
    } else if (nameKeyDiffers(known.value, rule.value)) {
      addNote(
        `Uses \`${rule.value}\` for \`${rule.key}\`; the shared rule says \`${known.value}\`.`,
      )
    } else if (known.section !== rule.section) {
      addNote(
        rule.section === "replaced"
          ? `The practice \`${rule.key}\` falls in this repository.`
          : `This repository follows \`${rule.key}\`, which the shared file lists as being replaced.`,
      )
    } else known.sources.set(sourceId, toEvidence(rule))
  }
  const render = () =>
    renderAreaFile(parsed.front, { ...parsed.area, rules, notes }, parsed.human)
  // The validator adds host fields of at most 1 KiB to a file.
  let text = render()
  while (
    Buffer.byteLength(text) > STEP_LIMITS.fileBytes - 1024 &&
    added.length
  ) {
    const last = added.pop()
    if (last.note) {
      notes.splice(notes.indexOf(last.note), 1)
      leftOut("63 KiB", `a note of ${sourceId}`)
    } else {
      rules.splice(rules.indexOf(last.rule), 1)
      leftOut("63 KiB", `the rule ${last.rule.key}`)
    }
    text = render()
  }
  // The evidence that the source adds to shared rules can still make the
  // file too large.
  if (Buffer.byteLength(text) > STEP_LIMITS.fileBytes - 1024)
    skip(
      parsed.path,
      "The area file would be larger than 63 KiB, so the script did not change it",
    )
  else outputs.set(parsed.path, text)
}

const nameKeyDiffers = (a, b) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") !==
  b.toLowerCase().replace(/[^a-z0-9]/g, "")

/** The name of a new file that differs from the family: the slug and the value of a differing rule. */
function differenceName(slug, family, comparisons, area) {
  const values = [
    ...comparisons.flatMap((c) => c.conflicts),
    ...comparisons.flatMap((c) => c.differing),
    ...area.rules.filter((r) => r.section === "rules"),
  ].map((r) => slugify(r.value))
  for (const token of values) {
    if (!token) continue
    const name = `${slug}-${token}`
    if (
      SLUG.test(name) &&
      !family.includes(name) &&
      !existingNames.includes(name)
    )
      return name
  }
  return null
}

// ---- main -------------------------------------------------------------------

const followed = [] // { path, evidence }
const touched = new Set()
for (const raw of proposed) {
  const slug = typeof raw?.slug === "string" ? raw.slug : ""
  if (!SLUG.test(slug) || slug.length > 60) {
    skip(null, "An area has no valid slug")
    continue
  }
  const summary = cleanText(raw.summary, 300)
  const evaluated = evaluate({ ...raw, slug })
  const area = {
    slug,
    summary,
    rules: evaluated.rules,
    notes: evaluated.notes,
  }
  const standing = area.rules.filter((r) => r.section === "rules")
  const family = familyOf(slug)
  const files = family.map(readAreaFile)
  const readable = files.filter((f) => !f.error)
  for (const bad of files.filter((f) => f.error))
    skip(
      bad.path,
      `The area file has a form that the script does not read: ${bad.error}`,
    )

  // Compare with the files in order: the files that already list this source first.
  const ordered = [
    ...readable.filter((f) => f.sources.includes(sourceId)),
    ...readable.filter((f) => !f.sources.includes(sourceId)),
  ]
  const comparisons = []
  let target = null
  for (const file of ordered) {
    const mine = file.sources.includes(sourceId)
    const others = file.sources.some((s) => s !== sourceId)
    if (mine && !others) {
      target = { file, decision: "update-own", cmp: null }
      break
    }
    // An earlier page of this run decided the file of the area; a later
    // page adds to it.
    if (mine && laterPage) {
      target = { file, decision: "add", cmp: null }
      break
    }
    const theirs = file.area.rules.filter(
      (r) =>
        r.section === "rules" &&
        [...r.sources.keys()].some((s) => s !== sourceId),
    )
    const cmp = compareRules(standing, theirs)
    comparisons.push({ file, cmp })
    if (cmp.decision !== "different") {
      target = { file, decision: cmp.decision, cmp }
      break
    }
  }

  let path = null
  if (target) {
    path = target.file.path
    if (touched.has(path)) {
      skip(path, `The area file was already changed by another area (${slug})`)
      continue
    }
    mergeInto(target.file, area)
  } else {
    if (standing.length < MIN_NEW_AREA_RULES || !summary) {
      skip(
        null,
        `The area ${slug} has ${standing.length} rules; a new area needs ${MIN_NEW_AREA_RULES} and a summary`,
      )
      continue
    }
    const name =
      family.length === 0
        ? slug
        : differenceName(
            slug,
            family,
            comparisons.map((c) => c.cmp),
            area,
          )
    if (!name) {
      skip(
        null,
        `The area ${slug} differs from its files, and no free name names the difference`,
      )
      continue
    }
    path = `knowledge/instructions/${name}.md`
    const seed = SEED_AREAS.find(([s]) => s === slug)
    const title = `${seed ? seed[1] : slug.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase())}${name === slug ? "" : ` (${name.slice(slug.length + 1).replaceAll("-", " ")})`}`
    mergeInto(
      {
        path,
        front: newFront(title, summary),
        area: { title, summary, rules: [], notes: [] },
        human: [],
      },
      area,
    )
  }
  touched.add(path)
  // The source leaves each other file of this family that still lists it.
  // On a later page, each such file is a file of this run.
  for (const file of laterPage ? [] : readable)
    if (
      file.path !== path &&
      file.sources.includes(sourceId) &&
      !touched.has(file.path)
    ) {
      leave(file)
      touched.add(file.path)
    }
  followed.push({
    path,
    evidence: standing[0]?.evidence[0] ?? area.rules[0]?.evidence[0],
  })
  report.push({
    area: slug,
    file: path,
    decision: target
      ? target.decision
      : family.length === 0
        ? "new"
        : "different",
    comparisons: comparisons.map(({ file, cmp }) => ({
      file: file.path,
      decision: cmp.decision,
      agreeing: cmp.agree,
      candidates: cmp.total,
      conflicts: cmp.conflicts.map((r) => r.key),
    })),
  })
}

// The first page writes the areas of the source again: the source leaves
// each other area file that lists it. The later pages add theirs.
if (!laterPage) {
  for (const name of existingNames) {
    const file = readAreaFile(name)
    if (
      !file.error &&
      file.sources.includes(sourceId) &&
      !touched.has(file.path)
    ) {
      leave(file)
      touched.add(file.path)
      report.push({
        area: name,
        file: file.path,
        decision: "leave",
        comparisons: [],
      })
    }
  }
}

// Each run of the script writes the whole page (SKILL.md asks for more than
// one run in a step), so it first drops the output of the run before.
for (const path of stagedPaths(step)) removeStaged(step, path)
writeDeletes(step, {})
rmSync(join(step.stepDir, "patch.json"), { force: true })
// The step stages at most 2 MiB. Room stays for the codebase file with
// its FOLLOWS claims.
let room = STEP_LIMITS.stagedBytes - STEP_LIMITS.fileBytes
for (const [path, text] of outputs) {
  room -= Buffer.byteLength(text) + 1024
  if (room < 0) {
    skip(path, "The step stages at most 2 MiB, so this area file was left out")
    outputs.delete(path)
    continue
  }
  const file = stagedFile(step, path)
  ensureParent(file)
  writeFileSync(file, text)
}
if (deletes.size) {
  const recorded = {}
  for (const [path, reason] of deletes) {
    const blob = baseBlob(step, path)
    if (blob) recorded[path] = { baseBlob: blob, reason }
  }
  writeDeletes(step, recorded)
}
writeFileSync(
  join(step.stepDir, "areas-report.json"),
  `${JSON.stringify({ areas: report }, null, 2)}\n`,
)

// The FOLLOWS claim comes from one codebase file: the repository unit that
// the first step of the run wrote (ADR-052 section 6), else the codebase
// file of the repository root in the map, else the shallowest.
const unit = index
  .filter(
    (e) =>
      e?.kind === "Repository" &&
      typeof e.path === "string" &&
      e.path.startsWith("knowledge/codebases/") &&
      Array.isArray(e.sources) &&
      e.sources.some((u) => normalizeSource(u) === sourceId),
  )
  .map((e) => ({ path: e.path, depth: -1 }))
const codebases = roots.flatMap((root) =>
  root.files
    .filter((f) => f.kind === "Repository" || f.kind === "Codebase")
    .map((f) => ({
      path: f.path,
      depth: root.path === "." ? 0 : root.path.split("/").length,
    })),
)
const codebase =
  [...unit, ...codebases].sort(
    (a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1),
  )[0]?.path ?? null
const plans = []
if (!codebase && followed.length)
  skip(
    null,
    "No codebase file of this source is in the context index or the root-to-file map, so no FOLLOWS claim was written",
  )
else
  for (const { path, evidence } of followed)
    // A new area file that the step left out gets no claim.
    if (evidence && (outputs.has(path) || baseBlob(step, path)))
      plans.push({
        path: codebase,
        create: null,
        related: [],
        claims: [
          {
            to: relativeTo(codebase, path),
            predicate: "FOLLOWS",
            evidence: { path: evidence, kind: "script" },
          },
        ],
      })
// The documents of this page that the proposal is done with are done.
writeStep(step, plans, skipped, {
  more: cursorAt < documents.length,
  cursorAt: () => cursorAt,
})
