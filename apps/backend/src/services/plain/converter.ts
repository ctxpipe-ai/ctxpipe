import slugify from "@sindresorhus/slugify"
import { NodeHtmlMarkdown } from "node-html-markdown"
import { isConnectorAssetCredentialUrl } from "../connectors/assets.js"
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
}

/**
 * The folders that one scope item owns in a Workspace (ADR-055). The sources
 * sync gives ownership by path prefix, so each item has its own folder.
 */
export function plainHelpCenterRoot(helpCenterId: string): string {
  return `plain/help-centers/${helpCenterId}/`
}

export function plainLabelRoot(labelTypeId: string): string {
  return `plain/threads/labels/${labelTypeId}/`
}

/** Plain priorities: a lower number is more urgent. */
const PRIORITIES = ["urgent", "high", "normal", "low"]

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

/** A URL that carries a credential: a signed URL, a token, or another scheme. */
function isPrivateUrl(url: string): boolean {
  // A link with another scheme (javascript:, data:) is never kept.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (scheme && !["http", "https", "mailto"].includes(scheme)) return true
  // A relative link resolves first, so its query is checked too.
  const absolute = scheme
    ? url
    : `https://plain.invalid${url.startsWith("/") ? "" : "/"}${url}`
  return (
    isConnectorAssetCredentialUrl(absolute, {
      includeGenericCredentials: true,
    }) ||
    /[?&](api[_-]?key|access[_-]?token|token|secret|signature)=/i.test(absolute)
  )
}

/**
 * Text without private URLs. A Markdown link to one keeps only its text; a
 * bare URL becomes a stub.
 */
function withoutPrivateUrls(text: string): string {
  return text
    .replace(
      /\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g,
      (link, label: string, url: string) => (isPrivateUrl(url) ? label : link),
    )
    .replace(/https?:\/\/[^\s<>()"']+/g, (url) =>
      isPrivateUrl(url) ? "[link removed]" : url,
    )
}

/**
 * Thread text without contact details or private URLs (ADR-055). Messages
 * and titles are free text from customers: email signatures carry
 * addresses and phone numbers. Other personal data can remain.
 */
function redactThreadText(text: string): string {
  return (
    withoutPrivateUrls(text)
      .replace(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        "[email removed]",
      )
      .replace(
        /\+\d[\d\s().-]{7,}\d|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g,
        "[phone removed]",
      )
      // A national number that starts with 0 (Australia, the UK): 9 to 11
      // digits in groups. The digit count keeps a spaced date out.
      .replace(/\b0\d{1,4}(?:[ -]\d{2,6}){1,3}\b/g, (match) => {
        const digits = match.replace(/\D/g, "").length
        return digits >= 9 && digits <= 11 ? "[phone removed]" : match
      })
  )
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
        content: `[Image: ${node.getAttribute("alt")?.trim() || "image"}]`,
        recurse: false,
      }),
    },
  )
  return withoutPrivateUrls(markdown)
}

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
    `# ${article.title}`,
    "",
  ]
  if (article.groupName) lines.push(`- Group: ${article.groupName}`, "")
  const body = articleBodyMarkdown(article.contentHtml).trim()
  if (body) lines.push(body, "")
  return {
    path: `${plainHelpCenterRoot(input.helpCenterId)}${slug}--${article.id}.md`,
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
    `# ${thread.ref}: ${redactThreadText(thread.title)}`,
    "",
    `- Status: ${thread.status}`,
    `- Priority: ${priority}`,
  ]
  if (thread.labels.length) lines.push(`- Labels: ${thread.labels.join(", ")}`)
  if (thread.customerName)
    lines.push(`- Customer: ${redactThreadText(thread.customerName)}`)
  lines.push("", "## Messages", "")
  if (!thread.messages.length) lines.push("No messages.", "")
  for (const message of thread.messages) {
    const heading = [
      message.authorName ? redactThreadText(message.authorName) : "Unknown",
      message.createdAt,
    ]
      .filter(Boolean)
      .join(", ")
    lines.push(
      `### ${heading}${message.internal ? " (internal note)" : ""}`,
      "",
      redactThreadText(message.text.trim()),
      "",
    )
  }
  return {
    path: `${plainLabelRoot(input.labelTypeId)}${thread.id}.md`,
    content: lines.join("\n"),
  }
}
