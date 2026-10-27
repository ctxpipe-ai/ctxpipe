import slugify from "@sindresorhus/slugify"
import { NodeHtmlMarkdown } from "node-html-markdown"

import { zendeskIdPattern } from "../../domain/workspace-sources/providers/zendesk.js"
import {
  articleText,
  customerLine,
  customerText,
  safeHref,
} from "../connectors/customer-text.js"
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

/** Customer text for one line (a subject, a name, a tag). */
function line(text: string): string {
  return customerLine(text, { maxChars: 2_048 })
}

/**
 * A comment body as a Markdown quote, so that customer text cannot add a
 * heading or another block to the file. A line that would still be a
 * heading or a heading underline inside the quote is escaped. A body that
 * is longer than the limit is cut, and the last line says so.
 */
function quotedTicketText(text: string): string {
  const { text: body, cut } = customerText(text, { maxChars: 16_384 })
  const quoted = body.split("\n").map((row) => (row ? `> ${row}` : ">"))
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
      a: ({ node }) => {
        const href = safeHref(node.getAttribute("href") ?? "", "full")
        return href ? { prefix: "[", postfix: `](${href})` } : {}
      },
      img: ({ node }) => ({
        content: `\\[Image: ${customerLine(node.getAttribute("alt") ?? "", { maxChars: 2_048 }) || "image"}\\]`,
        recurse: false,
      }),
    },
  )
  return articleText(markdown, "full")
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
  const title = line(article.title)
  const slug =
    slugify(customerLine(article.title, { maxChars: 2_048 })).slice(0, 80) ||
    "untitled"
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
  if (article.sectionName) lines.push(`- Section: ${line(article.sectionName)}`)
  if (article.authorName) lines.push(`- Author: ${line(article.authorName)}`)
  if (article.labels.length)
    lines.push(
      `- Labels: ${article.labels.map((label) => line(label)).join(", ")}`,
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
    `# Ticket #${ticket.id}: ${line(ticket.subject)}`,
    "",
    `- Zendesk: [#${ticket.id}](${ticket.url})`,
    `- Status: ${line(ticket.status)}`,
  ]
  if (ticket.priority) lines.push(`- Priority: ${line(ticket.priority)}`)
  if (ticket.type) lines.push(`- Type: ${line(ticket.type)}`)
  if (ticket.tags.length) lines.push(`- Tags: ${line(ticket.tags.join(", "))}`)
  if (ticket.requesterName)
    lines.push(`- Requester: ${line(ticket.requesterName)}`)
  if (ticket.assigneeName)
    lines.push(`- Assignee: ${line(ticket.assigneeName)}`)
  lines.push("", "## Comments", "")
  if (!ticket.comments.length) lines.push("No comments.", "")
  for (const comment of ticket.comments) {
    const heading = [
      comment.authorName ? line(comment.authorName) : "Unknown",
      comment.createdAt ? line(comment.createdAt) : null,
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
        `Attachments (in Zendesk): ${line(comment.attachments.join(", "))}`,
        "",
      )
  }
  return {
    path: `${zendeskViewRoot(input.viewId)}${ticket.id}.md`,
    content: lines.join("\n"),
  }
}
