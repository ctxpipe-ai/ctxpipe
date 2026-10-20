// The README quote of the readmes skill: the opening text of a README as a
// bounded quote for an `## Overview` section, and a one-paragraph summary.
// The host patch validator (apps/backend/src/domain/ingestion/patch-validator.ts)
// checks the result: no raw HTML, links only to the source repository, and
// no heading that addresses agents or models.
//
// - Badges, images, HTML blocks, inline HTML, and HTML comments go.
// - A relative link goes to the file in the source repository on GitHub, or
//   becomes plain text for another host. A link to another repository, a
//   bare URL, and an anchor in the README become plain text or go.
// - Fenced code stays as it is, outside the block quote, so that its text
//   is not read as prose.
// - The quote stops at a block boundary under MAX_QUOTE characters, and
//   before a heading that names agents or models.

import { posix } from "node:path"

const MAX_QUOTE = 4000
const MAX_SUMMARY = 300
/** A heading about agents or models: the quote stops before it. */
const AGENT_HEADING =
  /\b(?:ai|llms?|agents?|assistants?|prompts?|claude|chatgpt|gpt|copilot|cursor|gemini)\b/i
/** Characters that the validator refuses: control, zero-width, and direction characters. */
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the script removes control characters
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F؜​-‏‪-‮⁠⁦-⁩﻿]/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const HTML_BLOCK = /^ {0,3}(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)|<[!?])/
const REFERENCE = /^ {0,3}\[[^\]]+\]:/
/** A placeholder for a code span or a finished link: NUL never stays in the text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL marks a placeholder
const HOLD = /\u0000(\d+)\u0000/g

/** `host/owner/repository` in lower case, as the validator compares links. */
function repositoryKey(url) {
  try {
    const parsed = new URL(url)
    const [owner, name] = parsed.pathname.split("/").filter(Boolean)
    if (!owner || !name) return null
    return `${parsed.host}/${owner}/${name.replace(/\.git$/i, "")}`.toLowerCase()
  } catch {
    return null
  }
}

/** The target of a kept link, or null when the link becomes plain text. */
function linkTarget(target, { readmePath, sourceUrl }) {
  if (target === "" || target.startsWith("#") || target.startsWith("//"))
    return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (!/^https?:/i.test(target)) return null
    const key = repositoryKey(target)
    return key && key === repositoryKey(sourceUrl) ? target : null
  }
  let host
  try {
    host = new URL(sourceUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  // Only GitHub has a known URL for a file of the repository.
  if (host !== "github.com") return null
  const hash = target.indexOf("#")
  const fragment = hash === -1 ? "" : target.slice(hash)
  let path = (hash === -1 ? target : target.slice(0, hash)).split("?")[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  const joined = path.startsWith("/")
    ? posix.normalize(path.slice(1) || ".")
    : posix.normalize(posix.join(posix.dirname(readmePath), path))
  if (joined === ".." || joined.startsWith("../")) return null
  const base = sourceUrl.replace(/\/+$/, "").replace(/\.git$/i, "")
  const clean = joined.replace(/\/$/, "")
  const file =
    clean === "." || clean === ""
      ? base
      : `${base}/blob/HEAD/${clean.split("/").map(encodeURIComponent).join("/")}`
  return /^#[\w.-]+$/.test(fragment) ? `${file}${fragment}` : file
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

/** One line of prose with badges, images, HTML, and foreign links removed. */
function cleanLine(line, context) {
  const held = []
  const hold = (text) => `\u0000${held.push(text) - 1}\u0000`
  let text = line.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (span) =>
    hold(span),
  )
  text = text
    // A badge is an image in a link; an image alone goes too.
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/\[!\[[^\]]*\]\[[^\]]*\]\]\[[^\]]*\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(
      /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
      (_, label, target) => {
        const words = scrub(
          label.replace(HOLD, (_, n) => held[Number(n)]),
        ).trim()
        const url = words ? linkTarget(target, context) : null
        return hold(url ? `[${words}](${url})` : words)
      },
    )
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, (_, label) =>
      hold(scrub(label.replace(HOLD, (_, n) => held[Number(n)]))),
    )
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
    )
      prose.push(lines[i++])
    out.push({ type: "text", lines: prose })
  }
  return out
}

/** The blocks with their text cleaned; a block with no words left goes. */
function cleanBlocks(blocks, context) {
  const words = (text) => /[\p{L}\p{N}]/u.test(text)
  const out = []
  for (const block of blocks) {
    if (block.type === "code") out.push(block)
    else if (block.type === "heading") {
      const text = cleanLine(block.text, context).trim()
      if (words(text)) out.push({ ...block, text })
    } else {
      const lines = block.lines
        .filter((line) => !REFERENCE.test(line))
        .map((line) => cleanLine(line, context))
        .filter((line) => line.trim() !== "")
      if (lines.some(words)) out.push({ type: "text", lines })
    }
  }
  return out
}

/** Markdown of the quote: prose and headings in block quotes, code as it is. */
function render(blocks) {
  const parts = []
  let quote = null
  for (const block of blocks) {
    if (block.type === "code") {
      quote = null
      parts.push(block.lines.join("\n"))
      continue
    }
    const lines =
      block.type === "heading"
        ? [`${"#".repeat(block.level)} ${block.text}`]
        : block.lines
    const quoted = lines.map((line) => `> ${line}`.trimEnd())
    if (quote) quote.push(">", ...quoted)
    else {
      quote = quoted
      parts.push(quote)
    }
  }
  return parts
    .map((part) => (Array.isArray(part) ? part.join("\n") : part))
    .join("\n\n")
}

/** One paragraph as plain text for the summary, or null. */
function summaryOf(blocks) {
  const prose = blocks.find(
    (block) =>
      block.type === "text" &&
      !/^\s*(?:[-*+]|\d+[.)]|\||>)\s?/.test(block.lines[0]) &&
      !/^( {4}|\t)/.test(block.lines[0]),
  )
  if (!prose) return null
  const text = prose.lines
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length <= MAX_SUMMARY) return text
  const head = text.slice(0, MAX_SUMMARY)
  const sentence = head.lastIndexOf(". ")
  if (sentence > MAX_SUMMARY / 2) return head.slice(0, sentence + 1)
  const space = head.lastIndexOf(" ")
  return `${head.slice(0, space > 0 ? space : MAX_SUMMARY - 1)}…`
}

/**
 * The quote and the summary of one README, or null when no text is left.
 * `readmePath` is the path of the README in the source repository, and
 * `sourceUrl` the URL of the source repository.
 */
export function readmeOverview(raw, { readmePath, sourceUrl }) {
  let text = raw.replace(/\r\n?/g, "\n").replace(UNSAFE, "")
  const front = /^---\n[\s\S]{0,4096}?\n---(?:\n|$)/.exec(text)
  if (front) text = text.slice(front[0].length)
  const context = { readmePath, sourceUrl }
  const blocks = cleanBlocks(readBlocks(text), context)
  if (blocks[0]?.type === "heading" && blocks[0].level === 1) blocks.shift()
  const kept = []
  for (const block of blocks) {
    if (block.type === "heading" && AGENT_HEADING.test(block.text)) break
    if (render([...kept, block]).length > MAX_QUOTE) break
    kept.push(block)
  }
  while (kept.at(-1)?.type === "heading") kept.pop()
  if (!kept.length) return null
  return { quote: render(kept), summary: summaryOf(kept) }
}
