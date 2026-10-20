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
 * The folders that one scope item owns in a Workspace (ADR-056). The sources
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
      value === null ? [] : [`${name}: ${JSON.stringify(oneLine(value))}`],
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
 * Text that has no Markdown link, image, autolink, reference definition, or
 * raw HTML: the characters `\`, `[`, `]`, `<`, and `>` become literal. A
 * backslash is escaped only when it comes before one of these characters.
 */
const withoutMarkdownSyntax = (text: string) =>
  text.replace(/\\(?=[\\[\]<>])|[[\]<>]/g, "\\$&")

/**
 * Text without control and format characters, except tab and the line
 * ends. A format character (such as a bidi override or a zero-width mark)
 * can change how a reader or an agent sees the text.
 */
const withoutControls = (text: string) =>
  text.replace(/(?![\t\n\r])[\p{Cc}\p{Cf}]/gu, "")

/**
 * Each Markdown link keeps only its text, unless its target is a URL that
 * may stay. The pattern is linear: the text and the target have no
 * bracket, so a match starts once for each bracket, and a target can hold
 * pairs of parentheses but not nested ones.
 */
const withoutPrivateLinks = (text: string) =>
  text.replace(
    /\[([^[\]]*)\]\(([^\s()[\]]*(?:\([^\s()[\]]*\)[^\s()[\]]*)*)(?:\s+"[^"\n]*")?\)/g,
    (link, label: string, url: string) =>
      url.length <= 2_048 && isKeptUrl(url) ? link : label,
  )

/**
 * Text with only the URLs that may stay (see `isKeptUrl`). A bare URL that
 * does not stay becomes a stub. The pattern is linear: it has no length cap
 * and no nested quantifier. A URL over 2,048 characters does not stay, so a
 * credential at the end of a long URL cannot pass.
 */
function withHttpsUrlsOnly(text: string): string {
  return text.replace(/(?:https?:\/\/|\bwww\.)[^\s<>"']+/g, (match) => {
    // Punctuation after a URL is not part of the URL.
    let end = match.length
    while (end > 0 && ".,;:!?)]}\\".includes(match.charAt(end - 1))) end -= 1
    const url = match.slice(0, end)
    // A link that starts with `www.` is a link in GFM viewers: same filter.
    const target = url.startsWith("www.") ? `https://${url}` : url
    return url.length <= 2_048 && isKeptUrl(target)
      ? match
      : `[link removed]${match.slice(end)}`
  })
}

/**
 * Thread text without contact details or private URLs (ADR-056). Messages
 * and titles are free text from customers: email signatures carry
 * addresses and phone numbers. Other personal data can remain.
 */
function redactThreadText(text: string): string {
  // The strip comes first: a format character inside an address or a
  // parameter name must not hide it from the patterns.
  return (
    withHttpsUrlsOnly(withoutPrivateLinks(withoutControls(text)))
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

/** Text on one line, with no control character. */
const oneLine = (text: string) => withoutControls(text.replace(/\s+/g, " "))

/** Text from the Plain API as inline Markdown text on one line. */
const inline = (text: string) => withoutMarkdownSyntax(oneLine(text))

/** A title or a name from a customer: short, redacted, and on one line. */
const field = (text: string) => inline(redactThreadText(text.slice(0, 1_000)))

/**
 * A message body as a quote, with no link, image, or HTML. Markdown also
 * breaks a line at a carriage return, so each line break counts. A line
 * that would be a heading or a heading underline inside the quote is
 * escaped.
 */
const quote = (text: string) =>
  withoutMarkdownSyntax(withoutControls(text))
    .split(/\r\n?|[\n\u2028\u2029]/)
    .map((line) => line.replace(/^(\s*)(#|[=-]+\s*$)/, "$1\\$2"))
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
  return withHttpsUrlsOnly(withoutPrivateLinks(markdown))
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
    `# ${inline(article.title)}`,
    "",
  ]
  if (article.groupName) lines.push(`- Group: ${inline(article.groupName)}`, "")
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
    `# ${inline(thread.ref)}: ${field(thread.title)}`,
    "",
    `- Status: ${inline(thread.status)}`,
    `- Priority: ${priority}`,
  ]
  if (thread.labels.length)
    lines.push(`- Labels: ${inline(thread.labels.join(", "))}`)
  if (thread.customerName)
    lines.push(`- Customer: ${field(thread.customerName)}`)
  lines.push("", "## Messages", "")
  if (!thread.messages.length) lines.push("No messages.", "")
  for (const message of thread.messages) {
    // A fixed prefix gives the kind: a display name cannot change it.
    const kind = message.internal ? "Internal note" : "Message"
    const heading = [
      message.authorName ? field(message.authorName) : "Unknown",
      message.createdAt ? inline(message.createdAt) : null,
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
      `Plain has more messages in this thread. Open ${inline(thread.ref)} in Plain to read them.`,
      "",
    )
  return {
    path: `${plainLabelRoot(input.labelTypeId)}${pathSegment(thread.id, "thread")}.md`,
    content: lines.join("\n"),
  }
}
