// Pure parsing of one decision file: a design record in one of the forms of
// `decisionForm` (an ADR, a KEP, an RFC, a PEP, or a design document). The
// source repository is hostile, so every function reads text only, with no
// regular expression that can run long, and keeps only short, cleaned values.
//
// The rules follow the ctxpipe decision scope and status ADR (PR 350, ADR-036):
//   - Supersession comes from declared metadata: the front matter, a
//     `Status:` line or section, and a line that starts with "Supersedes" or
//     "Superseded by". In prose, only a sentence about this ADR counts
//     ("This ADR is superseded by ADR-N", "This decision supersedes ADR-N",
//     or a sentence that starts with "Supersedes"). Other prose can describe a
//     different ADR, so it is not read.
//   - A fenced code block and a quoted line are never read as metadata.

import { posix } from "node:path"

/** Folders whose Markdown files are decision files (ADRs). */
const DECISION_FOLDERS = new Set([
  "adr",
  "adrs",
  "decisions",
  "decision-records",
  "architecture-decisions",
  "architecture-decision-records",
])
/** Folders whose Markdown files are design documents. */
const DESIGN_FOLDERS = new Set([
  "design",
  "designs",
  "design-docs",
  "design-documents",
  "design-proposals",
])
/** Folders whose numbered Markdown files (`0042-name.md`) are RFCs. */
const RFC_FOLDERS = new Set(["rfc", "rfcs", "proposals"])
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
export const GENERIC_FOLDERS = new Set([
  ...DECISION_FOLDERS,
  ...DESIGN_FOLDERS,
  ...RFC_FOLDERS,
  "docs",
  "doc",
  "documentation",
  "architecture",
  "keps",
  "peps",
  "text",
])
/** The label of the number in the name of a decision of each form. */
export const FORM_LABEL = { adr: "ADR", kep: "KEP", rfc: "RFC", pep: "PEP" }

/**
 * The form of a design record, or null when the path is not one:
 *   - `kep`: `README.md` in a folder with `kep.yaml` (the metadata file), or a
 *     numbered or dated Markdown file in a `keps` folder (the older form).
 *   - `pep`: `pep-<number>` with a `.rst`, `.md`, or `.txt` extension.
 *   - `adr`: a Markdown file in a decision folder, or `adr-<number>.md`.
 *   - `rfc`: a numbered Markdown file in an `rfc`, `rfcs`, or `proposals`
 *     folder, or in a `text` folder next to the `0000-template.md` of the
 *     RFC process. The process merges only accepted RFCs into `text`.
 *   - `design`: a Markdown file in a design folder (`docs/design/`).
 * An index, a template, and a file in vendored code are never one.
 * `exists` says whether a path is a tracked file.
 * Returns { form, meta, merged }: `meta` is the metadata file of a KEP, and
 * `merged` is true for an RFC in a `text` folder.
 */
export function decisionForm(path, exists) {
  const segments = path.split("/")
  const base = segments.pop()
  const folders = segments.map((s) => s.toLowerCase())
  if (folders.some((s) => IGNORED_FOLDERS.has(s) || /template/.test(s)))
    return null
  if (/template/i.test(base)) return null
  const dir = segments.join("/")
  const markdown = /\.(md|markdown)$/i.test(base)
  if (/^readme\.(md|markdown)$/i.test(base)) {
    const meta = dir ? `${dir}/kep.yaml` : "kep.yaml"
    return exists(meta) ? { form: "kep", meta, merged: false } : null
  }
  if (/^pep-\d{1,5}\.(md|markdown|rst|txt)$/i.test(base))
    return { form: "pep", meta: null, merged: false }
  if (!markdown || /^(readme|index|_index|summary|toc)\b/i.test(base))
    return null
  const numbered = /^\d{1,8}-/.test(base)
  if (numbered && folders.includes("keps"))
    return { form: "kep", meta: null, merged: false }
  if (
    folders.some((s) => DECISION_FOLDERS.has(s)) ||
    /^adr[-_ ]?\d{1,6}\b/i.test(base)
  )
    return { form: "adr", meta: null, merged: false }
  if (numbered && folders.some((s) => RFC_FOLDERS.has(s)))
    return { form: "rfc", meta: null, merged: false }
  if (numbered && folders.at(-1) === "text") {
    const parent = segments.slice(0, -1).join("/")
    const template = (folder) =>
      exists(folder ? `${folder}/0000-template.md` : "0000-template.md")
    if (template(parent) || template(dir))
      return { form: "rfc", meta: null, merged: true }
  }
  if (folders.some((s) => DESIGN_FOLDERS.has(s)))
    return { form: "design", meta: null, merged: false }
  return null
}

/** The script reads this much of a file. */
export const MAX_TEXT = 256 * 1024
const MAX_LINES = 4000
/** A longer line is cut before any regular expression reads it. */
export const MAX_LINE = 2000
const MAX_TITLE = 120
const MAX_STATUS_TEXT = 60

/** Control, invisible, and direction characters, backticks, and angle brackets. */
const UNSAFE =
  // oxlint-disable-next-line no-control-regex -- the check refuses control and direction characters
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\x60<>]/g

/** Text that is safe to give to the model and to write into a YAML value or a heading. */
export function cleanText(text, max) {
  return String(text ?? "")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

/** The lines of a text: `fenced` for fenced code, `skip` for fenced code or a quote. */
function classify(text) {
  const lines = text
    .slice(0, MAX_TEXT)
    .split(/\r?\n/)
    .slice(0, MAX_LINES)
    .map((line) => line.slice(0, MAX_LINE))
  const out = []
  let fence = null
  for (const line of lines) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (mark) {
      if (fence === null) fence = mark[1][0]
      else if (mark[1][0] === fence) fence = null
      out.push({ text: line, fenced: true, skip: true })
      continue
    }
    const fenced = fence !== null
    out.push({
      text: line,
      fenced,
      skip: fenced || /^\s{0,3}>/.test(line),
    })
  }
  return out
}

/**
 * Key and list lines as lowercase `key` to a text; a list is joined into one
 * text. A YAML comment and the quotes of a value or an item are removed.
 */
function readFields(texts) {
  const fields = {}
  const value = (text) => {
    const trimmed = text.trim()
    const quoted = /^(["'])(.*?)\1/.exec(trimmed)
    return quoted ? quoted[2] : trimmed.replace(/\s+#.*$/, "").trim()
  }
  let key = null
  for (const text of texts) {
    const pair = /^([A-Za-z_][\w -]{0,40}):[ \t]*(.*)$/.exec(text)
    if (pair) {
      key = pair[1].toLowerCase().replace(/[ _]/g, "-")
      fields[key] = value(pair[2])
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(text)
    if (item && key) fields[key] = `${fields[key]}, ${value(item[1])}`
  }
  return fields
}

/** The front matter keys as lowercase `key` to a text; a list is joined into one text. */
function readFront(lines) {
  if (lines[0]?.text.trim() !== "---") return { front: {}, start: 0 }
  const end = lines.findIndex(
    (l, i) => i > 0 && i <= 80 && l.text.trim() === "---",
  )
  if (end === -1) return { front: {}, start: 0 }
  return {
    front: readFields(lines.slice(1, end).map((l) => l.text)),
    start: end + 1,
  }
}

/**
 * The RFC 822 header of a PEP (`PEP: 8`, `Status: Final`, `Replaces: 245`):
 * the key lines at the start of the file, up to the first empty line. A line
 * that starts with white space continues the value of the line before it.
 */
function readHeader(lines) {
  const texts = []
  let end = 0
  for (const { text } of lines.slice(0, 80)) {
    if (text.trim() === "") break
    end++
    if (/^\s/.test(text) && texts.length)
      texts[texts.length - 1] += ` ${text.trim()}`
    else texts.push(text)
  }
  if (!/^pep:\s*\d/i.test(texts[0] ?? "")) return { front: {}, start: 0 }
  return { front: readFields(texts), start: end }
}

/** The metadata file of a KEP (`kep.yaml`): its top-level keys. */
function readMeta(text) {
  return readFields(
    String(text ?? "")
      .slice(0, MAX_TEXT)
      .split(/\r?\n/)
      .slice(0, MAX_LINES)
      .map((line) => line.slice(0, MAX_LINE)),
  )
}

/**
 * The statuses, each with its words. The first word in the text wins; at one
 * place, the earlier status in this list wins ("active review" is proposed).
 * The words cover the ADR, KEP, RFC, PEP, and proposal processes.
 */
const STATUS_WORDS = [
  ["superseded", /\b(?:superseded|replaced)\b/i],
  ["rejected", /\b(?:rejected|declined)\b/i],
  ["withdrawn", /\bwithdrawn\b/i],
  ["postponed", /\b(?:postponed|deferred)\b/i],
  ["deprecated", /\b(?:deprecated|obsolete|retired|removed)\b/i],
  [
    "proposed",
    /\b(?:active review|awaiting review|scheduled for review|in review|returned for revision)\b/i,
  ],
  ["implemented", /\b(?:implemented|final|released)\b/i],
  ["implementable", /\bimplementable\b/i],
  ["provisional", /\bprovisional\b/i],
  ["accepted", /\b(?:accepted|approved|adopted|active|decided|in force)\b/i],
  ["proposed", /\b(?:proposed|pending|under review|rfc|open)\b/i],
  ["draft", /\b(?:draft|wip)\b/i],
]

/**
 * One of the statuses of STATUS_WORDS, or undeclared. The first word in the
 * text wins.
 */
export function normalizeStatus(text) {
  let best = null
  for (const [name, pattern] of STATUS_WORDS) {
    const at = text.search(pattern)
    if (at !== -1 && (best === null || at < best.at)) best = { name, at }
  }
  return best?.name ?? "undeclared"
}

/**
 * `Status: x`, `**Status:** x`, `**Status**: x`, `* Status: x`; the same for
 * `Date`, `Start Date` (an RFC), and `Created`.
 */
const HEADER_FIELD =
  /^(?:[-*+]\s+)?(?:\*\*|__)?(status|date|start date|created)(?:\s*:\s*(?:\*\*|__)?|(?:\*\*|__)\s*:)\s*(.*)$/i
const STATUS_HEADING = /^\s{0,3}#{1,6}\s+(?:\d{1,3}[.)]?\s+)?status\s*#*\s*$/i
const ANY_HEADING = /^\s{0,3}#{1,6}\s/
const SUPERSEDE_LINE =
  /^(?:[-*+]\s+)?(?:\*\*|__)?(supersedes|superseded[- ]by|replaces(?=\s*(?:\*\*|__)?\s*:)|replaced[- ]by(?=\s*(?:\*\*|__)?\s*:))\b(?:\*\*|__)?\s*:?\s*(.*)$/i

/**
 * The text of a level-1 ATX heading, without a closing `#` sequence, or
 * null. A regular expression finds only the start; the end is cut by hand,
 * so no quantifier can backtrack over the line.
 */
export function headingText(line) {
  const start = /^ {0,3}#[ \t]+/.exec(line)
  if (!start) return null
  let text = line.slice(start[0].length).trimEnd()
  let hashes = text.length
  while (hashes > 0 && text[hashes - 1] === "#") hashes--
  if (hashes === 0) return null
  if (hashes < text.length && /[ \t]/.test(text[hashes - 1]))
    text = text.slice(0, hashes)
  text = text.trimEnd()
  return text === "" ? null : text
}

/**
 * The two kinds of a supersession clause: this decision replaces another, or
 * another replaces it. `meta` is true for a value of declared metadata (front
 * matter, `kep.yaml`, a PEP header), where a bare number names a decision.
 */
const clause = (kind, text, meta = false) => ({
  kind,
  text: text.slice(0, 600),
  meta,
})

/** The kind of a supersession word: "supersedes" and "replaces", or "superseded by" and "replaced by". */
const kindOf = (word) =>
  /^(?:supersedes|replaces)$/i.test(word) ? "supersedes" : "supersededBy"

/** Clauses inside a status text such as "Accepted; supersedes ADR-3". */
function statusClauses(statusText) {
  const out = []
  for (const part of statusText.split(";")) {
    const by = /\b(?:superseded|replaced) by\b(.*)$/i.exec(part)
    if (by) out.push(clause("supersededBy", by[1]))
    const supersedes = /\bsupersedes\b(.*)$/i.exec(part)
    if (supersedes) out.push(clause("supersedes", supersedes[1]))
  }
  return out
}

/** Sentences of a paragraph, split after . ! or ? and a space. */
function sentences(paragraph) {
  return paragraph.split(/(?<=[.!?])\s+/).slice(0, 40)
}

// "This ADR", "This RFC", "*Note:* this KEP", and "this" alone.
const THIS = String.raw`(?:[*_]{0,2}note[*_]{0,2}\s*:[*_]{0,2}\s*)?this(?:\s+(?:adr|decision|record|document|rfc|kep|pep|proposal|design))?`
const PROSE_SUPERSEDED_BY = new RegExp(
  String.raw`^${THIS}\s+(?:is|was|has been|will be|is now)\s+superseded by\b(.*)$`,
  "i",
)
const PROSE_SUPERSEDES = new RegExp(
  String.raw`^${THIS}\s+supersedes\b(.*)$`,
  "i",
)

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]

/** An ISO date from `2026-01-02` or a PEP date (`05-Jul-2001`); null for none. */
function isoDateOf(text) {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)
  if (iso) return iso[1]
  const pep = /\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/.exec(text)
  const month = pep ? MONTHS.indexOf(pep[2].toLowerCase()) : -1
  if (month === -1) return null
  return `${pep[3]}-${String(month + 1).padStart(2, "0")}-${pep[1].padStart(2, "0")}`
}

/**
 * Parse a decision file. `form` is the result of `decisionForm`, and
 * `metaText` is the text of its metadata file (`kep.yaml`), or null.
 * Returns { form, title, number, status, statusText, date, clauses } where
 * `clauses` are the declared supersession clauses, each with the text that
 * holds the references.
 */
export function parseDecision(
  path,
  text,
  form = { form: "adr", meta: null, merged: false },
  metaText = null,
) {
  const all = classify(text)
  const head = form.form === "pep" ? readHeader(all) : readFront(all)
  // The metadata file of a KEP is its declared metadata: it wins.
  const front =
    metaText === null ? head.front : { ...head.front, ...readMeta(metaText) }
  const lines = all.slice(head.start)
  const clauses = []

  for (const [key, kind] of [
    ["supersedes", "supersedes"],
    ["replaces", "supersedes"],
    ["superseded-by", "supersededBy"],
    ["replaced-by", "supersededBy"],
  ])
    if (front[key]) clauses.push(clause(kind, front[key], true))

  let statusText = front.status ? front.status : null
  let date =
    front.date ??
    front["creation-date"] ??
    front.created ??
    front["start-date"] ??
    null
  let title = null
  let inStatusSection = 0
  const paragraph = []
  const flush = () => {
    if (paragraph.length === 0) return
    for (const sentence of sentences(paragraph.join(" "))) {
      const trimmed = sentence.trim()
      const by = PROSE_SUPERSEDED_BY.exec(trimmed)
      const sup = PROSE_SUPERSEDES.exec(trimmed)
      if (by) clauses.push(clause("supersededBy", by[1]))
      else if (sup) clauses.push(clause("supersedes", sup[1]))
      else {
        const start = /^(supersedes|superseded by)\b(.*)$/i.exec(trimmed)
        if (start) clauses.push(clause(kindOf(start[1]), start[2]))
      }
    }
    paragraph.length = 0
  }

  for (const { text: line, skip } of lines) {
    if (skip) {
      flush()
      continue
    }
    const heading = headingText(line)
    if (heading && title === null) title = heading
    if (ANY_HEADING.test(line)) {
      flush()
      inStatusSection = STATUS_HEADING.test(line) ? 6 : 0
      continue
    }
    if (inStatusSection > 0 && line.trim() !== "") {
      inStatusSection--
      if (statusText === null) statusText = line.trim()
      for (const c of statusClauses(line)) clauses.push(c)
      continue
    }
    // A header line can hold several fields: `**Status:** Accepted | **Date:** 2026-01-02`.
    let isHeader = false
    for (const segment of line.split("|")) {
      const field = HEADER_FIELD.exec(segment.trim())
      if (!field) continue
      isHeader = true
      if (
        field[1].toLowerCase() === "status" &&
        statusText === null &&
        field[2]
      )
        statusText = field[2].trim()
      if (field[1].toLowerCase() !== "status" && date === null && field[2])
        date = field[2].trim()
    }
    if (isHeader) {
      for (const c of statusClauses(line)) clauses.push(c)
      continue
    }
    const declared = SUPERSEDE_LINE.exec(line.trim())
    if (declared) {
      flush()
      clauses.push(clause(kindOf(declared[1]), declared[2]))
      continue
    }
    if (line.trim() === "") flush()
    else paragraph.push(line.trim())
  }
  flush()
  // The status text of the front matter or the header can hold clauses too.
  if (front.status) for (const c of statusClauses(front.status)) clauses.push(c)

  const cleanStatus = statusText ? cleanText(statusText, MAX_STATUS_TEXT) : ""
  let status = cleanStatus ? normalizeStatus(cleanStatus) : "undeclared"
  // The RFC process merges only accepted RFCs into `text`.
  if (status === "undeclared" && form.merged) status = "accepted"
  const declaredTitle = form.form === "kep" || form.form === "pep"
  const rawTitle =
    (declaredTitle ? (front.title ?? title) : (title ?? front.title)) ?? ""
  // A KEP README takes the name of its folder.
  const named = /^readme\./i.test(posix.basename(path))
    ? posix.dirname(path)
    : path
  const base = posix.basename(named).replace(/\.(md|markdown|rst|txt)$/i, "")
  // Remove "ADR-12:", "KEP-1029:", "12.", or "0005 -" at the start of a title.
  const stripped = rawTitle.replace(
    /^(?:(?:ADR|RFC|KEP|PEP)[-_ #]*)?\d{1,6}\s*[:.)–—-]\s*/i,
    "",
  )
  const declaredNumber = /^\s*0*(\d{1,6})\s*$/.exec(
    front["kep-number"] ?? front.pep ?? "",
  )
  return {
    form: form.form,
    title:
      cleanText(stripped, MAX_TITLE) ||
      cleanText(
        base
          .replace(/^(?:(?:adr|rfc|kep|pep)[-_ ]?)?\d{1,8}[-_ ]*/i, "")
          .replace(/[-_]+/g, " "),
        MAX_TITLE,
      ) ||
      cleanText(base, MAX_TITLE),
    number: declaredNumber
      ? Number(declaredNumber[1])
      : numberOf(named, rawTitle),
    status,
    statusText: cleanStatus || null,
    date: isoDateOf(date ?? ""),
    clauses,
  }
}

/**
 * The number from the file name (`0005-x.md`, `adr-5.md`, `ADR-005-x.md`,
 * `pep-0008.rst`) or the title (`ADR-5: x`, `KEP-1029: x`); null for none.
 */
export function numberOf(path, title = "") {
  const base = posix.basename(path)
  const fromName =
    /^(?:(?:adr|rfc|kep|pep)[-_ ]?)?0*(\d{1,6})(?=[-_.\s]|$)/i.exec(base)
  if (fromName) return Number(fromName[1])
  const fromTitle = /^(?:(?:adr|rfc|kep|pep)[-_ #]*)0*(\d{1,6})\b/i.exec(title)
  return fromTitle ? Number(fromTitle[1]) : null
}

/**
 * The references that a clause holds: decision numbers and repository paths.
 * A number has the form of its label (`ADR-24`, `RFC 1974`, `KEP-3570`,
 * `PEP 8`), or `form: null` for the form of the file that holds the clause:
 * a file name (`0024-x.md`), `#1755` in an RFC (an RFC has the number of its
 * pull request), and a bare number in declared metadata. A path comes from a
 * relative link, resolved from `dir` (a leading `/` is the repository root),
 * or from a path value of declared metadata. A URL is not read.
 */
export function extractRefs({ text, meta }, dir, form) {
  const numbers = new Map()
  const add = (refForm, n) =>
    numbers.set(`${refForm}:${n}`, { form: refForm, number: n })
  const paths = new Set()
  const addPath = (target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return
    const resolved = target.startsWith("/")
      ? resolveFrom(".", target.replace(/^\/+/, ""))
      : resolveFrom(dir, target)
    if (resolved) paths.add(resolved)
  }
  for (const m of text.matchAll(
    /\[[^\]\n]{0,200}\]\(([^)\s]{1,300})(?:\s+"[^"]*")?\)/g,
  ))
    addPath(m[1])
  for (const m of text.matchAll(/\b(ADR|RFC|KEP|PEP)[-_ #]*0*(\d{1,6})\b/gi))
    add(m[1].toLowerCase(), Number(m[2]))
  for (const m of text.matchAll(
    /\b0*(\d{1,6})-[\w.-]{0,100}\.(?:md|markdown)\b/gi,
  ))
    add(null, Number(m[1]))
  if (form === "rfc")
    for (const m of text.matchAll(/(?<![\w/])#0*(\d{1,6})\b/g))
      add(null, Number(m[1]))
  if (meta)
    for (const raw of text.split(/[\s,;]+/).slice(0, 50)) {
      const token = raw.replace(/^[("'<[]+|[)"'>\].]+$/g, "")
      const bare = /^#?0*(\d{1,6})$/.exec(token)
      if (bare) add(null, Number(bare[1]))
      else if (/\/|\.(md|markdown)$/i.test(token)) addPath(token)
    }
  return { numbers: [...numbers.values()], paths: [...paths] }
}

/** A link target resolved from a folder to a repository path; null when it leaves the repository. */
export function resolveFrom(dir, target) {
  let clean = target.split("#")[0].split("?")[0]
  try {
    clean = decodeURIComponent(clean)
  } catch {
    // Keep the raw text.
  }
  if (!clean || clean.startsWith("/")) return null
  const resolved = posix.normalize(posix.join(dir === "." ? "" : dir, clean))
  return resolved === "." || resolved.startsWith("..") ? null : resolved
}

/**
 * Paths of the repository that a decision file names: backticked repository
 * paths and relative Markdown links resolved from the file's folder. URLs are
 * ignored. `exists` says whether a path is a tracked file or folder.
 */
export function referencedPaths(text, dir, exists) {
  const found = new Set()
  let budget = 500
  for (const { text: line, fenced } of classify(text)) {
    if (fenced) continue
    for (const m of line.matchAll(/`([^`\n]{1,200})`/g)) {
      if (budget-- <= 0) return found
      const token = m[1]
        .trim()
        .replace(/[:#]L?\d+(?:-L?\d+)?$/, "")
        .replace(/\/+$/, "")
      if (
        !token ||
        /[\s*?[\]{}<>|]/.test(token) ||
        /^[a-z][a-z0-9+.-]*:/i.test(token)
      )
        continue
      const plain = token.replace(/^\.\//, "")
      if (plain.startsWith("/")) continue
      for (const candidate of [plain, resolveFrom(dir, token)]) {
        if (candidate && !candidate.includes("..") && exists(candidate)) {
          found.add(candidate)
          break
        }
      }
    }
    for (const m of line.matchAll(
      /\[[^\]\n]{0,200}\]\(([^)\s]{1,300})(?:\s+"[^"]*")?\)/g,
    )) {
      if (budget-- <= 0) return found
      const target = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#"))
        continue
      const resolved = resolveFrom(dir, target)
      if (resolved && exists(resolved)) found.add(resolved)
    }
  }
  return found
}
