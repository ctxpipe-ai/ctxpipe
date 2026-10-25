// Pure parsing of one decision file (an ADR). The source repository is
// hostile, so every function reads text only, with no regular expression that
// can run long, and keeps only short, cleaned values.
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

/** The front matter keys as lowercase `key` to a text; a list is joined into one text. */
function readFront(lines) {
  if (lines[0]?.text.trim() !== "---") return { front: {}, start: 0 }
  const end = lines.findIndex(
    (l, i) => i > 0 && i <= 80 && l.text.trim() === "---",
  )
  if (end === -1) return { front: {}, start: 0 }
  const front = {}
  let key = null
  for (const { text } of lines.slice(1, end)) {
    const pair = /^([A-Za-z_][\w -]{0,40}):[ \t]*(.*)$/.exec(text)
    if (pair) {
      key = pair[1].toLowerCase().replace(/[ _]/g, "-")
      front[key] = pair[2].trim().replace(/^(["'])(.*)\1$/, "$2")
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(text)
    if (item && key) front[key] = `${front[key]}, ${item[1].trim()}`
  }
  return { front, start: end + 1 }
}

const STATUS_WORDS = [
  ["superseded", /\b(?:superseded|replaced by)\b/i],
  ["rejected", /\b(?:rejected|declined)\b/i],
  ["deprecated", /\b(?:deprecated|obsolete|retired|withdrawn)\b/i],
  [
    "accepted",
    /\b(?:accepted|approved|adopted|active|implemented|decided|final|in force)\b/i,
  ],
  ["proposed", /\b(?:proposed|pending|under review|rfc|open)\b/i],
  ["draft", /\b(?:draft|wip)\b/i],
]

/** One of accepted, proposed, draft, deprecated, superseded, rejected, undeclared. The first word in the text wins. */
export function normalizeStatus(text) {
  let best = null
  for (const [name, pattern] of STATUS_WORDS) {
    const at = text.search(pattern)
    if (at !== -1 && (best === null || at < best.at)) best = { name, at }
  }
  return best?.name ?? "undeclared"
}

/** `Status: x`, `**Status:** x`, `**Status**: x`, `* Status: x`; the same for `Date`. */
const HEADER_FIELD =
  /^(?:[-*+]\s+)?(?:\*\*|__)?(status|date)(?:\s*:\s*(?:\*\*|__)?|(?:\*\*|__)\s*:)\s*(.*)$/i
const STATUS_HEADING = /^\s{0,3}#{1,6}\s+(?:\d{1,3}[.)]?\s+)?status\s*#*\s*$/i
const ANY_HEADING = /^\s{0,3}#{1,6}\s/
const SUPERSEDE_LINE =
  /^(?:[-*+]\s+)?(?:\*\*|__)?(supersedes|superseded by)\b(?:\*\*|__)?\s*:?\s*(.*)$/i

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

/** The two kinds of a supersession clause: this ADR replaces another, or another replaces it. */
const clause = (kind, text) => ({ kind, text: text.slice(0, 600) })

/** Clauses inside a status text such as "Accepted; supersedes ADR-3". */
function statusClauses(statusText) {
  const out = []
  for (const part of statusText.split(";")) {
    const by = /\bsuperseded by\b(.*)$/i.exec(part)
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

const THIS = String.raw`this\s+(?:adr|decision|record|document)`
const PROSE_SUPERSEDED_BY = new RegExp(
  String.raw`^${THIS}\s+(?:is|was|has been|will be|is now)\s+superseded by\b(.*)$`,
  "i",
)
const PROSE_SUPERSEDES = new RegExp(
  String.raw`^${THIS}\s+supersedes\b(.*)$`,
  "i",
)

/**
 * Parse a decision file. Returns { title, number, status, statusText, date,
 * clauses } where `clauses` are the declared supersession clauses, each with
 * the text that holds the references.
 */
export function parseDecision(path, text) {
  const all = classify(text)
  const { front, start } = readFront(all)
  const lines = all.slice(start)
  const clauses = []

  for (const [key, kind] of [
    ["supersedes", "supersedes"],
    ["superseded-by", "supersededBy"],
  ])
    if (front[key]) clauses.push(clause(kind, front[key]))

  let statusText = front.status ? front.status : null
  let date = front.date ?? null
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
        if (start)
          clauses.push(
            clause(
              start[1].toLowerCase() === "supersedes"
                ? "supersedes"
                : "supersededBy",
              start[2],
            ),
          )
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
      if (field[1].toLowerCase() === "date" && date === null && field[2])
        date = field[2].trim()
    }
    if (isHeader) {
      for (const c of statusClauses(line)) clauses.push(c)
      continue
    }
    const declared = SUPERSEDE_LINE.exec(line.trim())
    if (declared) {
      flush()
      clauses.push(
        clause(
          declared[1].toLowerCase() === "supersedes"
            ? "supersedes"
            : "supersededBy",
          declared[2],
        ),
      )
      continue
    }
    if (line.trim() === "") flush()
    else paragraph.push(line.trim())
  }
  flush()
  // The status text of the front matter or the header can hold clauses too.
  if (front.status) for (const c of statusClauses(front.status)) clauses.push(c)

  const cleanStatus = statusText ? cleanText(statusText, MAX_STATUS_TEXT) : ""
  const isoDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(date ?? "")?.[1] ?? null
  const rawTitle = title ?? front.title ?? ""
  const base = posix.basename(path).replace(/\.(md|markdown)$/i, "")
  // Remove "ADR-12:", "12.", or "0005 -" at the start of a title.
  const stripped = rawTitle.replace(
    /^(?:ADR[-_ #]*)?\d{1,6}\s*[:.)–—-]\s*/i,
    "",
  )
  const number = numberOf(path, rawTitle)
  return {
    title:
      cleanText(stripped, MAX_TITLE) ||
      cleanText(
        base
          .replace(/^(?:adr[-_ ]?)?\d{1,6}[-_ ]*/i, "")
          .replace(/[-_]+/g, " "),
        MAX_TITLE,
      ) ||
      cleanText(base, MAX_TITLE),
    number,
    status: cleanStatus ? normalizeStatus(cleanStatus) : "undeclared",
    statusText: cleanStatus || null,
    date: isoDate,
    clauses,
  }
}

/** The ADR number from the file name (`0005-x.md`, `adr-5.md`, `ADR-005-x.md`) or the title (`ADR-5: x`); null for none. */
export function numberOf(path, title = "") {
  const base = posix.basename(path)
  const fromName = /^(?:adr[-_ ]?)?0*(\d{1,6})(?=[-_.\s]|$)/i.exec(base)
  if (fromName) return Number(fromName[1])
  const fromTitle = /^(?:adr[-_ #]*)0*(\d{1,6})\b/i.exec(title)
  return fromTitle ? Number(fromTitle[1]) : null
}

/**
 * The references that a clause text holds: ADR numbers (`ADR-24`, `0024-x.md`)
 * and repository paths of relative links, resolved from `dir`. A URL is not
 * read.
 */
export function extractRefs(text, dir) {
  const numbers = new Set()
  const paths = new Set()
  for (const m of text.matchAll(
    /\[[^\]\n]{0,200}\]\(([^)\s]{1,300})(?:\s+"[^"]*")?\)/g,
  )) {
    const target = m[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue
    const resolved = resolveFrom(dir, target)
    if (resolved) paths.add(resolved)
  }
  for (const m of text.matchAll(/\bADR[-_ #]*0*(\d{1,6})\b/gi))
    numbers.add(Number(m[1]))
  for (const m of text.matchAll(
    /\b0*(\d{1,6})-[\w.-]{0,100}\.(?:md|markdown)\b/gi,
  ))
    numbers.add(Number(m[1]))
  return { numbers: [...numbers], paths: [...paths] }
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
