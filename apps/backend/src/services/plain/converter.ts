import slugify from "@sindresorhus/slugify"
import { NodeHtmlMarkdown } from "node-html-markdown"
import { isConnectorAssetCredentialUrl } from "../connectors/assets.js"
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
 * The folders that one scope item owns in a Workspace (ADR-055). The sources
 * sync gives ownership by path prefix, so each item has its own folder.
 */
export function plainHelpCenterRoot(helpCenterId: string): string {
  return `plain/help-centers/${connectorPathSegment(helpCenterId)}/`
}

export function plainLabelRoot(labelTypeId: string): string {
  return `plain/threads/labels/${connectorPathSegment(labelTypeId)}/`
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

/**
 * A URL that may stay in a file: an absolute `https:` URL that carries no
 * credential (a signed URL, a token, a key, a code, or a password in the
 * query or the fragment). A relative, `http:`, `mailto:`, or other URL does
 * not stay: a relative link has no meaning in git, and the others are not
 * needed.
 */
function isKeptUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false
  return !(
    isConnectorAssetCredentialUrl(url, {
      includeGenericCredentials: true,
    }) ||
    /[?&#][\w.-]*(token|key|secret|password|passwd|signature)=|[?&#](code|pwd|sig|auth)=/i.test(
      url,
    )
  )
}

/**
 * Text with only the URLs that may stay (see `isKeptUrl`). A Markdown link
 * to another URL keeps only its text; a bare URL becomes a stub.
 */
function withHttpsUrlsOnly(text: string): string {
  return text
    .replace(
      /\[([^\]]{0,500})\]\((\S{1,2048}?)(?:\s+"[^"]{0,500}")?\)/g,
      (link, label: string, url: string) => (isKeptUrl(url) ? link : label),
    )
    .replace(/https?:\/\/[^\s<>()"']{1,2048}/g, (url) =>
      isKeptUrl(url) ? url : "[link removed]",
    )
}

/**
 * Thread text without contact details or private URLs (ADR-055). Messages
 * and titles are free text from customers: email signatures carry
 * addresses and phone numbers. Other personal data can remain.
 */
function redactThreadText(text: string): string {
  return (
    withHttpsUrlsOnly(text)
      .replace(
        /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g,
        "[email removed]",
      )
      .replace(
        // A time zone such as UTC+10 is not a phone number.
        /(?<!(?:UTC|GMT)\s?)\+\d[\d\s().-]{7,30}\d|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g,
        "[phone removed]",
      )
      // A national number that starts with 0 (Australia, the UK): 9 to 11
      // digits, in groups, in one run, or after an area code in brackets.
      // The digit count keeps a spaced date out.
      .replace(
        /\(0\d{1,4}\)\s?\d{3,4}[ -]?\d{3,4}|\b0\d{1,4}(?:[ -]?\d{2,6}){1,3}\b/g,
        (match) => {
          const digits = match.replace(/\D/g, "").length
          return digits >= 9 && digits <= 11 ? "[phone removed]" : match
        },
      )
      // An Australian 1300 or 1800 number.
      .replace(/\b1[38]00[ -]?\d{3}[ -]?\d{3}\b/g, "[phone removed]")
  )
}

/** Text on one line: a title or a name cannot start a heading. */
const oneLine = (text: string) => text.replace(/\s+/g, " ")

/** A title or a name from a customer: short, redacted, and on one line. */
const field = (text: string) => oneLine(redactThreadText(text.slice(0, 1_000)))

/**
 * A message body as a quote: its text cannot start a heading. Markdown also
 * breaks a line at a carriage return, so each line break counts.
 */
const quote = (text: string) =>
  text
    .split(/\r\n?|[\n\u2028\u2029\u0085]/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")

/**
 * A message keeps 20,000 characters; Plain has the rest. The redaction runs
 * first (on at most 100,000 characters), so the cut cannot split an
 * address or a number.
 */
const cut = (text: string) =>
  text.length > 20_000
    ? `${text.slice(0, 20_000)}\n\n[The rest of this message is in Plain.]`
    : text

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
  return withHttpsUrlsOnly(markdown)
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
    `# ${oneLine(article.title)}`,
    "",
  ]
  if (article.groupName)
    lines.push(`- Group: ${oneLine(article.groupName)}`, "")
  const body = articleBodyMarkdown(article.contentHtml).trim()
  if (body) lines.push(body, "")
  return {
    path: `${plainHelpCenterRoot(input.helpCenterId)}${slug}--${connectorPathSegment(article.id)}.md`,
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
    `# ${oneLine(thread.ref)}: ${field(thread.title)}`,
    "",
    `- Status: ${oneLine(thread.status)}`,
    `- Priority: ${priority}`,
  ]
  if (thread.labels.length)
    lines.push(`- Labels: ${oneLine(thread.labels.join(", "))}`)
  if (thread.customerName)
    lines.push(`- Customer: ${field(thread.customerName)}`)
  lines.push("", "## Messages", "")
  if (!thread.messages.length) lines.push("No messages.", "")
  for (const message of thread.messages) {
    // A fixed prefix gives the kind: a display name cannot change it.
    const kind = message.internal ? "Internal note" : "Message"
    const heading = [
      message.authorName ? field(message.authorName) : "Unknown",
      message.createdAt ? oneLine(message.createdAt) : null,
    ]
      .filter(Boolean)
      .join(", ")
    lines.push(
      `### ${kind}: ${heading}`,
      "",
      quote(cut(redactThreadText(message.text.trim().slice(0, 100_000)))),
      "",
    )
  }
  if (thread.moreMessages)
    lines.push(
      `Plain has more messages in this thread. Open ${oneLine(thread.ref)} in Plain to read them.`,
      "",
    )
  return {
    path: `${plainLabelRoot(input.labelTypeId)}${connectorPathSegment(thread.id)}.md`,
    content: lines.join("\n"),
  }
}
