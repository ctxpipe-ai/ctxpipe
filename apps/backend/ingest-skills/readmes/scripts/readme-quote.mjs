// The README quote of the readmes skill: the first text of a README as a
// bounded quote for an `## Overview` section, and a one-paragraph summary.
// The host patch validator (apps/backend/src/domain/ingestion/patch-validator.ts)
// checks the result: no raw HTML, no heading that addresses agents or
// models, and a Source line for each quoted text.
//
// - Badges, images, HTML blocks, inline HTML, and HTML comments go.
// - Each link becomes its text, and each bare URL goes.
// - Fenced code stays as it is, outside the block quote, so that its text
//   is not read as prose.
// - Each block quote and each fenced block has a `Source:` line after it.
// - The quote stops at a block boundary under MAX_QUOTE characters, and
//   before a heading that the validator refuses. A first paragraph that is
//   longer stops at a sentence.
// - The quote stops before a block that puts an instruction phrase in a
//   quoted run that is not text of the README, because the validator
//   refuses that run.

import {
  DENIED_HEADINGS,
  INJECTION_PHRASES,
} from "../../bin/guard-patterns.mjs"

const MAX_QUOTE = 4000
const MAX_SUMMARY = 300
/** Characters that the validator refuses: control, zero-width, and direction characters. */
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the script removes control characters
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F؜​-‏‪-‮⁠⁦-⁩﻿]/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
/** The line under a setext heading: `=` for level 1, `-` for level 2. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
/** A first line that starts a list, a table, or a block quote, not a heading. */
const NOT_HEADING = /^\s*(?:[-*+]|\d+[.)]|\||>)\s?/
const HTML_BLOCK = /^ {0,3}(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)|<[!?])/
const REFERENCE = /^ {0,3}\[[^\]]+\]:/
/** A placeholder for a code span or a link text: NUL never stays in the text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL marks a placeholder
const HOLD = /\u0000(\d+)\u0000/g

/**
 * The index after the `)` of a link target that starts at `from`, or -1.
 * Parentheses in the target nest, as in `[a](https://x.example/x_(y))`.
 */
function targetEnd(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === "\\") i++
    else if (c === "(") depth++
    else if (c === ")") {
      if (depth === 0) return i + 1
      depth--
    }
  }
  return -1
}

/**
 * Text with each inline link `[label](target)` replaced by `label(text)`, and
 * each inline image `![alt](target)` removed. An image in a link (a badge)
 * goes in a second pass, when its link has an empty label.
 */
function withoutTargets(text, label) {
  let out = text
  for (let pass = 0; pass < 2; pass++) {
    const start = /(!?)\[([^[\]]*)\]\(/g
    let next = ""
    let at = 0
    for (let match = start.exec(out); match; match = start.exec(out)) {
      const end = targetEnd(out, start.lastIndex)
      if (end === -1) continue
      next += out.slice(at, match.index) + (match[1] ? "" : label(match[2]))
      at = end
      start.lastIndex = end
    }
    out = next + out.slice(at)
  }
  return out
}

/** Text with HTML and each URL removed: for link text and for prose. */
function scrub(text) {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<[!?][a-z][^>]*>?/gi, "")
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/[ \t]*<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, "")
    .replace(/[ \t]*\b(?:https?|ftp|file):\/\/[^\s<>()\]"'`]+/gi, "")
    .replace(
      /[ \t]*(?<![\w.@/:-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>()]*/gi,
      "",
    )
    .replace(/[ \t]*(?<![\w/:])\/\/[a-z0-9.-]+\.[a-z]{2,}\S*/gi, "")
}

/** One line of prose with badges, images, HTML, link targets, and URLs removed. */
function cleanLine(line) {
  const held = []
  const hold = (text) => `\u0000${held.push(text) - 1}\u0000`
  const label = (text) =>
    hold(scrub(text.replace(HOLD, (_, n) => held[Number(n)])).trim())
  let text = line.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (span) =>
    hold(span),
  )
  text = withoutTargets(text, label)
    // A reference image goes; a reference link becomes its text.
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, (_, text) => label(text))
  text = scrub(text)
    .replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ")
    .trimEnd()
  // A held text never holds a placeholder, so one pass restores each.
  return text.replace(HOLD, (_, n) => held[Number(n)] ?? "")
}

/** The blocks of a README: headings, fenced code, and prose. HTML blocks go. */
function readBlocks(text) {
  const lines = text.split("\n")
  const out = []
  let i = 0
  const startsBlock = (line) =>
    FENCE.test(line) || HEADING.test(line) || HTML_BLOCK.test(line)
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }
    const fence = FENCE.exec(line)?.[1]
    if (fence) {
      const code = [line.replace(/^ {0,3}/, "")]
      i++
      let closed = false
      while (i < lines.length) {
        const current = lines[i++]
        const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(current)?.[1]
        if (end && end[0] === fence[0] && end.length >= fence.length) {
          code.push(end)
          closed = true
          break
        }
        code.push(current)
      }
      if (!closed) code.push(fence)
      out.push({ type: "code", lines: code })
      continue
    }
    if (/^ {0,3}<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes("-->")) i++
      i++
      continue
    }
    if (HTML_BLOCK.test(line)) {
      while (i < lines.length && lines[i].trim() !== "") i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ type: "heading", level: heading[1].length, text: heading[2] })
      i++
      continue
    }
    const prose = []
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      (prose.length === 0 || !startsBlock(lines[i]))
    ) {
      // A paragraph with a `===` or `---` line under it is a setext heading.
      const setext = SETEXT.exec(lines[i])?.[1]
      if (prose.length && setext && !NOT_HEADING.test(prose[0])) {
        i++
        out.push({
          type: "heading",
          level: setext[0] === "=" ? 1 : 2,
          text: prose.map((l) => l.trim()).join(" "),
        })
        prose.length = 0
        break
      }
      prose.push(lines[i++])
    }
    if (prose.length) out.push({ type: "text", lines: prose })
  }
  return out
}

/** The blocks with their text cleaned; a block with no words left goes. */
function cleanBlocks(blocks) {
  const words = (text) => /[\p{L}\p{N}]/u.test(text)
  const out = []
  for (const block of blocks) {
    if (block.type === "code") out.push(block)
    else if (block.type === "heading") {
      const text = cleanLine(block.text).trim()
      if (words(text)) out.push({ ...block, text })
    } else {
      const lines = block.lines
        .filter((line) => !REFERENCE.test(line))
        .map(cleanLine)
        .filter((line) => line.trim() !== "")
      if (lines.some(words)) out.push({ type: "text", lines })
    }
  }
  return out
}

/**
 * The runs of the quote: each block quote of prose and headings, and each
 * fenced block as it is.
 */
function quoteRuns(blocks) {
  const runs = []
  let quote = null
  for (const block of blocks) {
    if (block.type === "code") {
      quote = null
      runs.push({ code: true, lines: block.lines })
      continue
    }
    const lines =
      block.type === "heading"
        ? [`${"#".repeat(block.level)} ${block.text}`]
        : block.lines
    const quoted = lines.map((line) => `> ${line}`.trimEnd())
    if (quote) quote.lines.push(">", ...quoted)
    else {
      quote = { code: false, lines: quoted }
      runs.push(quote)
    }
  }
  return runs
}

/**
 * Markdown of the quote: prose and headings in block quotes, code as it is.
 * A `Source:` line follows each block quote and each fenced block, so that
 * the validator finds the source of each quoted text (ADR-052 section 5).
 */
function render(blocks, readmePath) {
  return quoteRuns(blocks)
    .map((run) => `${run.lines.join("\n")}\n\nSource: \`${readmePath}\``)
    .join("\n\n")
}

/** Text as the validator compares a quote with its source: no block-quote marks, whitespace normalized. */
const quotable = (lines) =>
  lines
    .map((line) => line.replace(/^[ \t]*(?:>[ \t]?)*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

/**
 * False when the validator refuses the quote: a run that is not text of the
 * README (the script removed a link target or changed a heading) has an
 * instruction phrase in it or across its edge. A phrase is shorter than 200
 * characters, so the test reads 200 characters on each side of the run.
 */
function trueToSource(blocks, source) {
  const texts = quoteRuns(blocks).map((run) =>
    quotable(run.code ? run.lines.slice(1, -1) : run.lines),
  )
  const all = texts.join(" ")
  let at = 0
  return texts.every((text) => {
    const start = at
    at += text.length + 1
    if (source.includes(text)) return true
    const near = all.slice(Math.max(0, start - 200), start + text.length + 200)
    return !INJECTION_PHRASES.some((pattern) => pattern.test(near))
  })
}

/**
 * A heading that the validator refuses, also with its emphasis marks
 * removed. The validator decodes character references (`&#65;`, `&nbsp;`),
 * so a heading with a reference also stops the quote.
 */
const deniedHeading = (text) =>
  /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(text) ||
  [text, text.replace(/[*_~`]/g, "")].some((t) =>
    DENIED_HEADINGS.some((pattern) => pattern.test(t)),
  )

/**
 * The longest start of a text block that ends at a sentence and for which
 * `fits` is true, or null.
 */
function cutAtSentence(block, fits) {
  const text = block.lines.join("\n")
  const ends = [...text.matchAll(/[.!?](?=\s)/g)].map((m) => m.index + 1)
  for (const end of ends.reverse()) {
    const cut = { type: "text", lines: text.slice(0, end).split("\n") }
    if (fits(cut)) return cut
  }
  return null
}

/**
 * One paragraph as plain text for the summary, or null. A paragraph that
 * the validator reads as an instruction gives null: the validator scans the
 * front matter with no quote rule.
 */
function summaryOf(blocks) {
  const prose = blocks.find(
    (block) =>
      block.type === "text" &&
      !NOT_HEADING.test(block.lines[0]) &&
      !/^( {4}|\t)/.test(block.lines[0]),
  )
  if (!prose) return null
  const text = prose.lines.join(" ").replace(/\s+/g, " ").trim()
  if (INJECTION_PHRASES.some((pattern) => pattern.test(text))) return null
  if (text.length <= MAX_SUMMARY) return text
  const head = text.slice(0, MAX_SUMMARY)
  const sentence = head.lastIndexOf(". ")
  if (sentence > MAX_SUMMARY / 2) return head.slice(0, sentence + 1)
  const space = head.lastIndexOf(" ")
  return `${head.slice(0, space > 0 ? space : MAX_SUMMARY - 1)}…`
}

/**
 * The quote and the summary of one README, or null when no text is left.
 * `readmePath` is the path of the README in the source repository: the
 * quote gives it in its `Source:` lines.
 */
export function readmeOverview(raw, readmePath) {
  let text = raw.replace(/\r\n?/g, "\n").replace(UNSAFE, "")
  const front = /^---\n[\s\S]{0,4096}?\n---(?:\n|$)/.exec(text)
  if (front) text = text.slice(front[0].length)
  const blocks = cleanBlocks(readBlocks(text))
  if (blocks[0]?.type === "heading" && blocks[0].level === 1) blocks.shift()
  const source = quotable(raw.split("\n"))
  const kept = []
  const fits = (block) =>
    render([...kept, block], readmePath).length <= MAX_QUOTE &&
    trueToSource([...kept, block], source)
  for (const block of blocks) {
    if (block.type === "heading" && deniedHeading(block.text)) break
    if (fits(block)) {
      kept.push(block)
      continue
    }
    // A long first paragraph stops at a sentence, so that the README gives
    // a quote.
    const cut =
      block.type === "text" && !kept.some((b) => b.type === "text")
        ? cutAtSentence(block, fits)
        : null
    if (cut) kept.push(cut)
    break
  }
  while (kept.at(-1)?.type === "heading") kept.pop()
  if (!kept.length) return null
  return { quote: render(kept, readmePath), summary: summaryOf(kept) }
}
