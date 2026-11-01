import slugify from "@sindresorhus/slugify"
import { NodeHtmlMarkdown } from "node-html-markdown"

import {
  articleText,
  customerLine,
  customerText,
  safeHref,
} from "../connectors/customer-text.js"
import { connectorPathSegment } from "../connectors/path-segment.js"
import type { GitFileChange } from "../git/file-change.js"

export type PlainArticleForMirror = {
  id: string
  title: string
  slug: string
  contentHtml: string
  groupName: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type PlainThreadForMirror = {
  id: string
  ref: string
  title: string
  status: string
  priority: number
  customerName: string | null
  labels: string[]
  createdAt: string | null
  updatedAt: string | null
  messages: Array<{
    authorName: string | null
    createdAt: string | null
    /** A note: only the support team sees it. */
    internal: boolean
    /** The plain-text form that Plain gives (`llmText`). */
    text: string
  }>
  /** Plain has more messages than the file shows. */
  moreMessages: boolean
}

/**
 * The folders that one scope item owns in a Workspace (ADR-059). The sources
 * sync gives ownership by path prefix, so each item has its own folder.
 */
export function plainHelpCenterRoot(helpCenterId: string): string {
  return `plain/help-centers/${pathSegment(helpCenterId, "Help Center")}/`
}

export function plainLabelRoot(labelTypeId: string): string {
  return `plain/threads/labels/${pathSegment(labelTypeId, "label")}/`
}

/**
 * A Plain id as a path segment. A real Plain id is already safe. Another id
 * is refused, not repaired, so that two ids cannot share one file.
 */
function pathSegment(id: string, what: string): string {
  if (!id || connectorPathSegment(id) !== id)
    throw new Error(`A Plain ${what} id is not safe in a path`)
  return id
}

/** Plain priorities: a lower number is more urgent. */
const PRIORITIES = ["urgent", "high", "normal", "low"]

function frontMatter(fields: Array<[string, string | null]>): string[] {
  return [
    "---",
    ...fields.flatMap(([name, value]) =>
      value === null
        ? []
        : [`${name}: ${JSON.stringify(value.replace(/\s+/g, " "))}`],
    ),
    "---",
    "",
  ]
}

/**
 * A message body as a quote. The shared redaction (`customerText`) leaves
 * only line feeds as line ends and escapes the Markdown characters. A line
 * that would be a heading or a heading underline inside the quote is
 * escaped.
 */
function quote(lines: string): string {
  return lines
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

/**
 * Article HTML as Markdown. An image is a text stub in this version. A
 * private URL never reaches git.
 */
function articleBodyMarkdown(html: string): string {
  const markdown = NodeHtmlMarkdown.translate(
    html,
    { bulletMarker: "-", codeBlockStyle: "fenced" },
    {
      img: ({ node }) => ({
        content: `\\[Image: ${customerLine(node.getAttribute("alt") ?? "", { maxChars: 1_000 }) || "image"}\\]`,
        recurse: false,
      }),
      a: ({ node }) => {
        const href = safeHref(
          node.getAttribute("href") ?? "",
          "credential-links",
        )
        return href ? { prefix: "[", postfix: `](${href})` } : {}
      },
    },
  )
  return articleText(markdown, "credential-links")
}

const line = (text: string) => customerLine(text, { maxChars: 1_000 })

export function plainArticleFile(input: {
  helpCenterId: string
  article: PlainArticleForMirror
}): GitFileChange {
  const { article } = input
  const slug = slugify(article.slug).slice(0, 80) || "untitled"
  const lines = [
    ...frontMatter([
      ["source", "plain"],
      ["plain_id", article.id],
      ["help_center_id", input.helpCenterId],
      ["slug", article.slug],
      ["created_at", article.createdAt],
      ["updated_at", article.updatedAt],
    ]),
    `# ${line(article.title)}`,
    "",
  ]
  if (article.groupName) lines.push(`- Group: ${line(article.groupName)}`, "")
  const body = articleBodyMarkdown(article.contentHtml).trim()
  if (body) lines.push(body, "")
  return {
    path: `${plainHelpCenterRoot(input.helpCenterId)}${slug}--${pathSegment(article.id, "article")}.md`,
    content: lines.join("\n"),
  }
}

export function plainThreadFile(input: {
  labelTypeId: string
  thread: PlainThreadForMirror
}): GitFileChange {
  const { thread } = input
  const priority = PRIORITIES[thread.priority] ?? String(thread.priority)
  const lines = [
    ...frontMatter([
      ["source", "plain"],
      ["plain_id", thread.id],
      ["ref", thread.ref],
      ["label_id", input.labelTypeId],
      ["status", thread.status],
      ["priority", priority],
      ["created_at", thread.createdAt],
      ["updated_at", thread.updatedAt],
    ]),
    `# ${line(thread.ref)}: ${line(thread.title)}`,
    "",
    `- Status: ${line(thread.status)}`,
    `- Priority: ${priority}`,
  ]
  if (thread.labels.length)
    lines.push(`- Labels: ${line(thread.labels.join(", "))}`)
  if (thread.customerName)
    lines.push(`- Customer: ${line(thread.customerName)}`)
  lines.push("", "## Messages", "")
  if (!thread.messages.length) lines.push("No messages.", "")
  for (const message of thread.messages) {
    // A fixed prefix gives the kind: a display name cannot change it.
    const kind = message.internal ? "Internal note" : "Message"
    const body = customerText(message.text, { maxChars: 20_000 })
    const heading = [
      message.authorName ? line(message.authorName) : "Unknown",
      message.createdAt ? line(message.createdAt) : null,
    ]
      .filter(Boolean)
      .join(", ")
    lines.push(
      `### ${kind}: ${heading}`,
      "",
      quote(
        body.cut
          ? `${body.text}\n\n\\[The rest of this message is in Plain.\\]`
          : body.text,
      ),
      "",
    )
  }
  if (thread.moreMessages)
    lines.push(
      `Plain has more messages in this thread. Open ${line(thread.ref)} in Plain to read them.`,
      "",
    )
  return {
    path: `${plainLabelRoot(input.labelTypeId)}${pathSegment(thread.id, "thread")}.md`,
    content: lines.join("\n"),
  }
}
