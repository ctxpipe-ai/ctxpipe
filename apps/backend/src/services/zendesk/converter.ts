import slugify from "@sindresorhus/slugify"
import { NodeHtmlMarkdown } from "node-html-markdown"
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
 * The folders that one scope item owns in a Workspace (ADR-054). The sources
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

/** Link text without the brackets that would end it. */
function linkText(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/[[\]]/g, "\\$&")
}

/**
 * Article HTML as Markdown. An image is a text stub in this version: the
 * article link has it. A link to a signed or credential-bearing URL keeps
 * only its text, so the URL never reaches git.
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
  return markdown.replace(
    /\[([^\]]*)\]\(([^)\s]+)\)/g,
    (link, text: string, url: string) =>
      isConnectorAssetCredentialUrl(url) ? text : link,
  )
}

export function zendeskArticleFile(input: {
  categoryId: string
  article: ZendeskArticleForMirror
}): GitFileChange {
  const { article } = input
  const slug = slugify(article.title).slice(0, 80) || "untitled"
  const lines = [
    ...frontMatter([
      ["source", "zendesk"],
      ["zendesk_id", article.id],
      ["url", article.url],
      ["category_id", input.categoryId],
      ["section_id", article.sectionId],
      ["locale", article.locale],
      ["created_at", article.createdAt],
      ["updated_at", article.updatedAt],
    ]),
    `# ${article.title}`,
    "",
    `- Zendesk: [${linkText(article.title)}](${article.url})`,
  ]
  if (article.sectionName) lines.push(`- Section: ${article.sectionName}`)
  if (article.authorName) lines.push(`- Author: ${article.authorName}`)
  if (article.labels.length)
    lines.push(`- Labels: ${article.labels.join(", ")}`)
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
    `# Ticket #${ticket.id}: ${ticket.subject}`,
    "",
    `- Zendesk: [#${ticket.id}](${ticket.url})`,
    `- Status: ${ticket.status}`,
  ]
  if (ticket.priority) lines.push(`- Priority: ${ticket.priority}`)
  if (ticket.type) lines.push(`- Type: ${ticket.type}`)
  if (ticket.tags.length) lines.push(`- Tags: ${ticket.tags.join(", ")}`)
  if (ticket.requesterName) lines.push(`- Requester: ${ticket.requesterName}`)
  if (ticket.assigneeName) lines.push(`- Assignee: ${ticket.assigneeName}`)
  lines.push("", "## Comments", "")
  if (!ticket.comments.length) lines.push("No comments.", "")
  for (const comment of ticket.comments) {
    const heading = [comment.authorName ?? "Unknown", comment.createdAt]
      .filter(Boolean)
      .join(", ")
    lines.push(
      `### ${heading}${comment.public ? "" : " (internal note)"}`,
      "",
      comment.body.trim(),
      "",
    )
    if (comment.attachments.length)
      lines.push(
        `Attachments (in Zendesk): ${comment.attachments.join(", ")}`,
        "",
      )
  }
  return {
    path: `${zendeskViewRoot(input.viewId)}${ticket.id}.md`,
    content: lines.join("\n"),
  }
}
