import slugify from "@sindresorhus/slugify"
import { NodeHtmlMarkdown } from "node-html-markdown"

import { zendeskIdPattern } from "../../domain/workspace-sources/providers/zendesk.js"
import { isConnectorAssetCredentialUrl } from "../connectors/assets.js"
import type { GitFileChange } from "../git/file-change.js"

export type ZendeskArticleForMirror = {
  id: string
  title: string
  url: string
  bodyHtml: string
  sectionId: string | null
  sectionName: string | null
  locale: string | null
  labels: string[]
  authorName: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type ZendeskTicketForMirror = {
  id: string
  subject: string
  url: string
  status: string
  priority: string | null
  type: string | null
  tags: string[]
  requesterName: string | null
  assigneeName: string | null
  createdAt: string | null
  updatedAt: string | null
  comments: Array<{
    authorName: string | null
    createdAt: string | null
    public: boolean
    /** The plain-text body that Zendesk gives. */
    body: string
    /** File names only: attachment URLs are private. */
    attachments: string[]
  }>
}

/**
 * The folders that one scope item owns in a Workspace (ADR-058). The sources
 * sync gives ownership by path prefix, so each item has its own folder.
 */
export function zendeskCategoryRoot(categoryId: string): string {
  return `zendesk/help-center/categories/${categoryId}/`
}

export function zendeskViewRoot(viewId: string): string {
  return `zendesk/tickets/views/${viewId}/`
}

function frontMatter(fields: Array<[string, string | null]>): string[] {
  return [
    "---",
    ...fields.flatMap(([name, value]) =>
      value === null ? [] : [`${name}: ${JSON.stringify(value)}`],
    ),
    "---",
    "",
  ]
}

/** A Zendesk id: digits only, because the id is a path segment. */
export function isZendeskId(value: string): boolean {
  return zendeskIdPattern.test(value)
}

/**
 * The line ends of CommonMark (`\n`, `\r`, `\r\n`) and the two Unicode ones
 * (U+2028, U+2029) that some renderers also use.
 */
const lineBreak = /\r\n|[\r\n\u2028\u2029]/

/**
 * Text without control, format, and default-ignorable characters, except
 * tab, line feed, and carriage return. Such a character (a bidi override, a
 * zero-width mark, a variation selector, a Hangul filler) can change how a
 * reader or an agent sees the text. The strip runs before the redaction, so
 * that such a character cannot hide an email address or a phone number from
 * it. NFKC turns a full-width digit, a Unicode space, and a look-alike of
 * `@` or `.` into the plain character that the redaction knows. A combining
 * accent stays.
 */
function withoutControlCharacters(text: string): string {
  return text
    .replace(/(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .normalize("NFKC")
}

/** The lines of customer text, split at every line end. */
function linesOf(text: string): string[] {
  return withoutControlCharacters(text).split(lineBreak)
}

/** Customer text on one line: each line trimmed, the blank ones dropped. */
function oneLine(text: string): string {
  return linesOf(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
}

/**
 * A comment body keeps this many characters, and a one-line field keeps
 * fewer. The redaction cost follows the length of the text that it reads.
 */
const MAX_COMMENT_CHARS = 16 * 1024
const MAX_LINE_CHARS = 2 * 1024

/**
 * The start of the text up to `max` characters. The cut moves back to the
 * last space or line end, so that no part of a word stays; it looks back at
 * most 2,100 characters. A part of an email address, such as
 * `jo.smith@example.`, is not an address to the redaction. When that range
 * holds no space (CJK text), the cut stays at `max` and moves back only over
 * address characters. Last, the cut moves back over phone characters, so
 * that no part of a phone number stays.
 */
function startOf(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false }
  const head = text.slice(0, max)
  const floor = Math.max(0, head.length - 2100)
  let end = head.length
  while (end > floor && !/\s/.test(head[end - 1] ?? "")) end -= 1
  if (end === floor && !/\s/.test(head[end - 1] ?? "")) {
    end = head.length
    while (end > 0 && /[\w.%+@-]/.test(head[end - 1] ?? "")) end -= 1
  }
  while (end > 0 && /[\d\s().+-]/.test(head[end - 1] ?? "")) end -= 1
  return { text: head.slice(0, end), cut: true }
}

/**
 * One line of text for a heading, a list item, or a link label. A
 * redaction marker stays as it is, except when a `(`, `[` or `:` follows
 * it: then it is escaped too, so that a marker the customer typed cannot
 * become a link.
 */
function escapeLine(text: string): string {
  return text
    .split(/(\[(?:email|phone|link) removed\](?![([:]))/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/[\\<#[\]]/g, (mark) =>
            mark === "<" ? "&lt;" : `\\${mark}`,
          ),
    )
    .join("")
}

/** A URL that carries a credential: a signed URL, a token, or a Zendesk attachment token path. */
function isPrivateUrl(url: string): boolean {
  // A relative link resolves first, so its query is checked too.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url)
    ? url
    : `https://zendesk.invalid${url.startsWith("/") ? "" : "/"}${url}`
  return (
    isConnectorAssetCredentialUrl(absolute, {
      includeGenericCredentials: true,
    }) ||
    /\/attachments\/token\//.test(absolute) ||
    /[?&](api[_-]?key|access[_-]?token|token|secret|signature)=/i.test(absolute)
  )
}

/**
 * A Markdown link target that the mirror keeps: an https or a relative link
 * without a credential. A link with another scheme (http:, mailto:,
 * javascript:, data:) keeps only its text.
 */
function keepsLinkTarget(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  return (scheme === undefined || scheme === "https") && !isPrivateUrl(url)
}

/**
 * Text without private URLs. A Markdown link to one keeps only its text; a
 * bare or angle-bracket URL becomes a stub.
 */
function withoutPrivateUrls(text: string): string {
  return text
    .replace(
      // No bracket in the label or the target, so that a match starts once
      // and a long run of brackets costs linear time.
      /\[([^[\]]*)\]\(([^\s)[]+)(?:\s+"[^"]*")?\)/g,
      (link, label: string, url: string) =>
        keepsLinkTarget(url) ? link : label,
    )
    .replace(/https?:\/\/[^\s<>()"']+/g, (url) =>
      isPrivateUrl(url) ? "[link removed]" : url,
    )
}

/**
 * Text in which each URL has no query and no fragment: the scheme, the host
 * and the path stay. The query of a URL in a ticket can hold any credential,
 * so no list of parameter names decides. The query ends at a space, at `<` or
 * `>`, or at the `](` of a Markdown link. A closing bracket or a punctuation
 * mark at the end stays when the text around the URL needs it, but a `)` that
 * the query opened goes with the query.
 */
function withoutUrlQueries(text: string): string {
  // Where a URL base can start. A scheme starts once for each run of scheme
  // characters.
  const starts = [
    ...text.matchAll(
      /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/|(?<![a-z0-9])www\.|\]\(|(?<![\w.@/-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/|(?<![\w:/])\/\//gi,
    ),
  ].map((match) => match.index)
  const queryEnd = /[\s<>]|\]\(|\)(?=\[)/g
  let out = ""
  let copied = 0
  let segment = 0
  let next = 0
  // A base runs from a start to the first of a space, `<`, `>`, `?`, or `#`.
  // It has a query when that character is `?` or `#`.
  for (const stop of text.matchAll(/[\s<>?#]/g)) {
    const at = stop.index
    if (at < copied) continue
    segment = Math.max(segment, copied)
    if (stop[0] === "?" || stop[0] === "#") {
      while (next < starts.length && (starts[next] ?? 0) < segment) next += 1
      if (next < starts.length && (starts[next] ?? 0) < at) {
        queryEnd.lastIndex = at + 1
        const end = queryEnd.exec(text)?.index ?? text.length
        out += text.slice(copied, at) + endMarksOf(text.slice(at, end))
        copied = end
        segment = end
        continue
      }
    }
    segment = at + 1
  }
  return out + text.slice(copied)
}

/** The end marks of a removed query that the text around the URL needs. */
function endMarksOf(query: string): string {
  let start = query.length
  while (start > 0 && `)]}.,;:!?'"*_`.includes(query[start - 1] ?? ""))
    start -= 1
  const open = (query.match(/\(/g) ?? []).length
  const close = (query.match(/\)/g) ?? []).length
  let unmatched = close - open
  // Keep the end marks from the right: a `)` only while the text before
  // the query opened it.
  let kept = ""
  for (const mark of [...query.slice(start)].reverse()) {
    if (mark === ")") {
      if (unmatched <= 0) break
      unmatched -= 1
    }
    kept = mark + kept
  }
  return kept
}

/** Dates and times stay: `2026-10-14`, `14.10.2026`, `09:00`. */
const datePattern =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[./]\d{1,2}[./]\d{2,4}(?!\.\d)(?: \d{2}:\d{2})?/
    .source

/**
 * A run of digit groups that can be a phone number: an optional `+`, then
 * digit groups with one space, dot or dash between them, and brackets around
 * a group. A run never starts after a letter, a digit, `.`, `/`, `#` or `-`
 * (a version, a path, a ticket reference) and never ends before a letter, a
 * digit or `:` (a time).
 */
const phoneRunPattern =
  /(?<![\w.+/#-])(?:\+ ?)?\(?\d+(?:(?:\) ?|(?:[ \t]{1,3}|[.-])\(?|\()(?!\d{4}-\d{2}-\d{2})\d+)*(?![\w:])/
    .source

/**
 * Text without phone numbers: 9 to 15 digits in one run, or a short local
 * number such as `555-1234`. In a code span, a run of digit groups with only
 * dots between them is a version and stays.
 */
function withoutPhoneNumbers(text: string): string {
  const pattern = new RegExp(`(${datePattern})|${phoneRunPattern}`, "g")
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) =>
      part.replace(pattern, (match, date: string | undefined) => {
        if (date) return match
        if (index % 2 === 1 && /^\d+(?:\.\d+)+$/.test(match)) return match
        const digits = match.replace(/\D/g, "").length
        return (digits >= 9 && digits <= 15) || /^\d{3}-\d{4}$/.test(match)
          ? "[phone removed]"
          : match
      }),
    )
    .join("")
}

/**
 * Ticket text without contact details or private URLs (ADR-058). Comments
 * and subjects are free text from end customers: email signatures carry
 * addresses and phone numbers. Other personal data can remain.
 */
export function redactTicketText(text: string): string {
  return withoutPhoneNumbers(
    withoutUrlQueries(withoutPrivateUrls(text))
      // Credentials before the host of a URL with any scheme.
      .replace(
        /\b([a-z][a-z0-9+.-]{0,31}):\/\/[^\s/?#@]{1,256}@/gi,
        "$1://[credentials removed]@",
      )
      // A link with a script or data scheme that a bracket in its target
      // kept out of the link pass.
      .replace(/\b(?:javascript|data|vbscript|file):\S*/gi, "[link removed]")
      // The left guard makes a match start once for each run of address
      // characters, so a long run costs linear time.
      .replace(
        /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        "[email removed]",
      ),
  )
}

/**
 * Customer text for one line (a subject, a name, a tag): one line, with no
 * HTML and no Markdown heading or link syntax.
 */
function inlineTicketText(text: string): string {
  const { text: head, cut } = startOf(oneLine(text), MAX_LINE_CHARS)
  return `${escapeLine(redactTicketText(head))}${cut ? " [truncated]" : ""}`
}

/**
 * A comment body as a Markdown quote, so that customer text cannot add a
 * heading or another block to the file. A line that would still be a
 * heading or a heading underline inside the quote is escaped. A body that
 * is longer than the limit is cut, and the last line says so.
 */
function quotedTicketText(text: string): string {
  const { text: head, cut } = startOf(
    withoutControlCharacters(text).trim(),
    MAX_COMMENT_CHARS,
  )
  const quoted = redactTicketText(head)
    .split(lineBreak)
    .map((line) => {
      const escaped = line
        .replace(/^(\s*)(#|[=-]+\s*$)/, "$1\\$2")
        .replace(/</g, "&lt;")
      return escaped ? `> ${escaped}` : ">"
    })
  return [...quoted, ...(cut ? ["> [comment truncated]"] : [])].join("\n")
}

/**
 * The article link, only when it is an https link on the account's own
 * Zendesk host. A bracket in it is encoded, so it cannot end the link.
 */
function articleUrl(url: string, subdomain: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== `${subdomain.toLowerCase()}.zendesk.com` ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    return null
  return parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29")
}

/**
 * Article HTML as Markdown. An image is a text stub in this version: the
 * article link has it. A private URL never reaches git.
 */
function articleBodyMarkdown(html: string): string {
  const markdown = NodeHtmlMarkdown.translate(
    html,
    { bulletMarker: "-", codeBlockStyle: "fenced" },
    {
      img: ({ node }) => ({
        content: `[Image: ${node.getAttribute("alt")?.trim() || "image"}]`,
        recurse: false,
      }),
    },
  )
  return redactTicketText(withoutControlCharacters(markdown))
}

export function zendeskArticleFile(input: {
  /** The account's subdomain: the article link must be on its host. */
  subdomain: string
  categoryId: string
  article: ZendeskArticleForMirror
}): GitFileChange {
  const { article } = input
  if (!isZendeskId(article.id))
    throw new Error("A Zendesk article id must be a number")
  const title = inlineTicketText(article.title)
  const slug =
    slugify(redactTicketText(oneLine(article.title))).slice(0, 80) || "untitled"
  const url = articleUrl(article.url, input.subdomain)
  const lines = [
    ...frontMatter([
      ["source", "zendesk"],
      ["zendesk_id", article.id],
      ["url", url],
      ["category_id", input.categoryId],
      ["section_id", article.sectionId],
      ["locale", article.locale],
      ["created_at", article.createdAt],
      ["updated_at", article.updatedAt],
    ]),
    `# ${title}`,
    "",
    url ? `- Zendesk: [${title}](${url})` : `- Zendesk: ${title}`,
  ]
  if (article.sectionName)
    lines.push(`- Section: ${inlineTicketText(article.sectionName)}`)
  if (article.authorName)
    lines.push(`- Author: ${inlineTicketText(article.authorName)}`)
  if (article.labels.length)
    lines.push(
      `- Labels: ${article.labels.map((label) => inlineTicketText(label)).join(", ")}`,
    )
  const body = articleBodyMarkdown(article.bodyHtml).trim()
  lines.push("", ...(body ? [body, ""] : []))
  return {
    path: `${zendeskCategoryRoot(input.categoryId)}${slug}--${article.id}.md`,
    content: lines.join("\n"),
  }
}

export function zendeskTicketFile(input: {
  viewId: string
  ticket: ZendeskTicketForMirror
}): GitFileChange {
  const { ticket } = input
  if (!isZendeskId(ticket.id))
    throw new Error("A Zendesk ticket id must be a number")
  const lines = [
    ...frontMatter([
      ["source", "zendesk"],
      ["zendesk_id", ticket.id],
      ["url", ticket.url],
      ["view_id", input.viewId],
      ["status", ticket.status],
      ["priority", ticket.priority],
      ["created_at", ticket.createdAt],
      ["updated_at", ticket.updatedAt],
    ]),
    `# Ticket #${ticket.id}: ${inlineTicketText(ticket.subject)}`,
    "",
    `- Zendesk: [#${ticket.id}](${ticket.url})`,
    `- Status: ${escapeLine(oneLine(ticket.status))}`,
  ]
  if (ticket.priority)
    lines.push(`- Priority: ${escapeLine(oneLine(ticket.priority))}`)
  if (ticket.type) lines.push(`- Type: ${escapeLine(oneLine(ticket.type))}`)
  if (ticket.tags.length)
    lines.push(`- Tags: ${inlineTicketText(ticket.tags.join(", "))}`)
  if (ticket.requesterName)
    lines.push(`- Requester: ${inlineTicketText(ticket.requesterName)}`)
  if (ticket.assigneeName)
    lines.push(`- Assignee: ${inlineTicketText(ticket.assigneeName)}`)
  lines.push("", "## Comments", "")
  if (!ticket.comments.length) lines.push("No comments.", "")
  for (const comment of ticket.comments) {
    const heading = [
      comment.authorName ? inlineTicketText(comment.authorName) : "Unknown",
      comment.createdAt ? escapeLine(oneLine(comment.createdAt)) : null,
    ]
      .filter(Boolean)
      .join(", ")
    lines.push(
      `### ${heading}${comment.public ? "" : " (internal note)"}`,
      "",
      quotedTicketText(comment.body),
      "",
    )
    if (comment.attachments.length)
      lines.push(
        `Attachments (in Zendesk): ${inlineTicketText(comment.attachments.join(", "))}`,
        "",
      )
  }
  return {
    path: `${zendeskViewRoot(input.viewId)}${ticket.id}.md`,
    content: lines.join("\n"),
  }
}
