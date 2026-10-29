/**
 * Customer support text (tickets, threads, and their fields) as Markdown that
 * other people read in a Workspace repository. The text is untrusted: a
 * customer wrote it. The Plain and Zendesk converters use this one module, so
 * that one review covers both (CTX-1046). The helper owns the order (strip,
 * cut, redact, escape), because the order is the security rule.
 *
 * Where the two converters had different rules, the stricter rule wins,
 * unless it removes normal text that a reader needs:
 * - One-line fields: line breaks become one space before the redaction
 *   (Zendesk). Plain collapsed them after, so a phone number split by a line
 *   break stayed.
 * - Escape: `\ [ ] < >` are literal in all customer text, and the markers
 *   are escaped with it (Plain). `<` and `>` are written as `&lt;` and `&gt;`
 *   (Zendesk wrote `&lt;` in quotes). Zendesk kept `[ ]` live in quotes, so
 *   it needed a scheme pass and link rules. In a body, a line that would be a
 *   heading or a heading underline is escaped too (both converters did this
 *   after the redaction; the helper now owns it). A one-line field does not
 *   start a line, so its `#` is not escaped, but its backtick is: a field can
 *   go into live Markdown (an image alt in an article).
 * - Parser check: each entry point parses its result as CommonMark and as
 *   GFM (`isUnsafeMarkdown`). When a parser finds a live node, the result is
 *   the redacted text with each punctuation character escaped.
 * - URLs: each URL loses its userinfo, query, and fragment (Zendesk). Plain
 *   kept a query with no known credential name. A URL with another scheme
 *   than https keeps its scheme, host, and path (Zendesk); Plain removed it,
 *   but it holds no credential and a reader can need it. A path segment named
 *   `token` removes the URL (the Zendesk attachment rule, made generic).
 *   The userinfo goes before the query, so a `#` or `?` in a password does
 *   not keep part of it. Each policy removes each userinfo, also of a `www.`
 *   URL, a URL with no scheme, and a URL inside another URL.
 * - Credential parameters: removed anywhere in the text, not only after
 *   `?`, `&`, or `#` (Plain had the list; Zendesk had none outside URLs).
 * - Emails: Unicode local parts and domains. Both converters matched ASCII
 *   only.
 * - Phones: one digit-count rule (Zendesk), which also catches what Plain's
 *   three patterns missed (no separators, a country code with no `+`).
 * - Cut: one cut, before the redaction (see `cutAt`). Plain cut twice.
 * - Article links: only an absolute https link stays (Plain). Zendesk kept a
 *   relative link, which has no meaning in git.
 *
 * Known costs in normal text:
 * - Any run of 9 to 15 digits becomes `[phone removed]`: an order number, a
 *   Unix time, a SKU, an ISBN, a ZIP+4 code, or a `Ref:` number.
 * - `code=` is a credential name, so `status code=404` becomes
 *   `code=[removed]`.
 * - An `@` in a query reads as the end of a userinfo:
 *   `https://x.com?e=jo@example.com` becomes
 *   `https://[credentials removed]@example.com`. A `/` in a password is not
 *   found (`postgres://admin:pa/ss@host`), because a path can hold an `@`.
 * - A body keeps the escapes inside a code fence (`\[`, `&lt;`), because the
 *   escape does not parse Markdown.
 * - An article with HTML, a link that is not https, more than 200,000
 *   characters, or a shape that is slow to parse becomes inert text: its
 *   headings, lists, and links show as plain text. A tag that the article
 *   shows as text (`&lt;b&gt;` in its HTML) is not HTML: it is written as
 *   `&lt;b&gt;` outside code. Slow shapes are rare in normal articles: a
 *   code block of more than about 25,000 characters with no blank line and
 *   a bracket that does not pair, a table of more than about 10,000 cells
 *   in all, or a line with more than 128 columns of indentation and
 *   container marks (a list of depth 10 or more from node-html-markdown,
 *   or deeply indented code).
 * - A body of more than 200,000 characters after the escape, with a `[`,
 *   `<`, `@`, `://`, or `www.`, also becomes inert text (the parser limit).
 * - The result can be longer than `maxChars`: the markers and the escapes
 *   add characters after the cut. A caller must not expect the limit.
 */

import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"

/**
 * The strip at entry. A control, format, or default-ignorable character
 * (a bidi override, a zero-width mark, a variation selector, a Hangul filler)
 * can hide an address from the redaction, so it goes first. Tab, line feed,
 * and carriage return stay. NFKC then turns full-width digits, Unicode spaces,
 * and look-alikes of `@` and `.` into the characters that the redaction knows.
 * NFKC skips Hangul compatibility jamo and vulgar fractions, because it would
 * change normal text. It also skips the forms that it would turn into
 * `[ ] < > \` or a backtick, so that NFKC cannot make a live Markdown mark.
 * A removed run between two backticks becomes one space, so that the strip
 * cannot join two backtick runs into one longer code span mark.
 *
 * Each class is plain (no lookahead in a repeated group), because V8 needs
 * one backtrack frame for each repeat of a group, and 5,000,000 frames
 * overflow its stack.
 */
function stripped(text: string): string {
  return text
    .replace(
      // oxlint-disable-next-line no-control-regex -- the strip removes controls
      /(?<=`)[\p{Cf}\p{Default_Ignorable_Code_Point}\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]+(?=`)/gu,
      " ",
    )
    .replace(
      // oxlint-disable-next-line no-control-regex -- the strip removes controls
      /[\p{Cf}\p{Default_Ignorable_Code_Point}\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]+/gu,
      "",
    )
    .replace(
      /[^ㄱ-ㆎ¼-¾⅐-⅟↉\u1FEF\uFE47\uFE48\uFE64\uFE65\uFE68\uFF1C\uFF1E\uFF3B-\uFF3D\uFF40]+/g,
      (run) => run.normalize("NFKC"),
    )
}

/**
 * Text in which the `marks` are literal, so that no link, image, reference,
 * autolink, or HTML can form. `<` and `>` become `&lt;` and `&gt;`, because
 * in GFM a literal autolink takes the `\` of `\<`, and the `<` is then
 * live. The other marks get a `\`. A backslash is escaped only before a mark
 * or at the end of the text: the caller can write a mark after the text (the
 * converter's `\]` after an image alt). The escape runs once, after the
 * redaction, so it also escapes each marker: a marker that the customer typed
 * and a marker that the redaction wrote look the same, and neither can become
 * a link.
 */
function escaped(text: string, marks: RegExp): string {
  return text.replace(marks, (mark) =>
    mark === "<" ? "&lt;" : mark === ">" ? "&gt;" : `\\${mark}`,
  )
}

/** Dates and times stay: `2026-10-14`, `14.10.2026`, `14/10/2026 09:00`. */
const datePattern =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[./]\d{1,2}[./]\d{2,4}(?!\.\d)(?: \d{2}:\d{2})?/
    .source

/**
 * A run of digit groups that can be a phone number: an optional `+`, then
 * digit groups with one to three spaces or tabs, one dot, one dash, or one
 * minus sign between them, and brackets around a group. A run does not start after a letter, a
 * digit, `.`, `/`, `#`, or `-` (a version, a path, a ticket reference), but a
 * `+` can follow a letter (`Mob+61`). A run does not end before a letter, a
 * digit, or `:` (a time).
 */
const phoneRunPattern =
  /(?:(?<![\w.+/#-])|(?<=\p{L})(?=\+))(?:\+ ?)?\(?\d+(?:(?:\) ?|(?:[ \t]{1,3}|[.\p{Pd}−])\(?|\()(?!\d{4}-\d{2}-\d{2})\d+)*(?![\w:])/u
    .source

const phoneOrDate = new RegExp(`(${datePattern})|${phoneRunPattern}`, "gu")

/**
 * Text without phone numbers: 9 to 15 digits in one run, or a local number
 * such as `555-1234`. One digit-count rule covers national, international,
 * and unspaced numbers. A long order number or a Unix time also has 9 to 15
 * digits, so it goes too: that is the known cost of the rule. In a code span,
 * a run of digit groups with only dots between them is a version and stays.
 * An opening bracket that the run took, with no closing bracket in it, stays
 * before the marker, so that the brackets stay as a pair.
 */
function withoutPhones(text: string, mark: Marker): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) =>
      part.replace(phoneOrDate, (match, date: string | undefined) => {
        if (date) return match
        if (index % 2 === 1 && /^\d+(?:\.\d+)+$/.test(match)) return match
        const digits = match.replace(/\D/g, "").length
        if (!((digits >= 9 && digits <= 15) || /^\d{3}-\d{4}$/.test(match)))
          return match
        return /^\([^)]*$/.test(match)
          ? `(${mark("phone removed")}`
          : mark("phone removed")
      }),
    )
    .join("")
}

/**
 * Text without email addresses. The local part and the domain can have any
 * letter, mark, or digit (`josé@`, a Cyrillic look-alike in the domain). The
 * ideographic full stop `。` also separates the labels of the domain. In
 * text with no spaces (Chinese, Japanese) the address also takes the letters
 * next to it: that text goes with it. A backslash can be in the local part,
 * because the article Markdown escapes `_` and `*`.
 *
 * The match starts at `@`, and each part has a bound (64 characters before
 * `@`, 253 for the domain, 63 for the last label), as in RFC 5321. A long run
 * of non-Latin letters in an unbounded Unicode class fills the V8 backtrack
 * stack, so the bounds also keep a long article from a crash.
 */
function withoutEmails(text: string, mark: Marker): string {
  let out = ""
  let copied = 0
  for (const match of text.matchAll(
    /@[\p{L}\p{M}\p{N}.。-]{1,253}[.。]\p{L}{2,63}/gu,
  )) {
    let start = match.index
    while (
      start > copied &&
      start > match.index - 64 &&
      /[\p{L}\p{M}\p{N}._%+\\-]/u.test(text.charAt(start - 1))
    )
      start -= 1
    if (start === match.index) continue
    out += `${text.slice(copied, start)}${mark("email removed")}`
    copied = match.index + match[0].length
  }
  return out + text.slice(copied)
}

/**
 * The names of a credential parameter. The same list serves the parameters
 * in text and the queries of an article link.
 */
const credentialName =
  /[\w.-]*(?:token|key|secret|password|passwd|signature)|code|pwd|sig|auth/
    .source

/**
 * Text without the value of a credential parameter (`token=`, `api_key=`,
 * `sig=`), also outside a URL. A name does not start inside a word, so
 * `barcode=` stays. In Markdown, the value ends at a backtick, so that it
 * cannot remove the end of a code span.
 */
function withoutCredentialParameters(text: string, to: Output): string {
  return text.replace(
    new RegExp(`(?<![\\w.-])(${credentialName})=([^\\s&#${to.stop}]*)`, "gi"),
    (_match, name: string, value: string) =>
      `${name}=${to.mark("removed")}${escapeAt(value, value.length)}`,
  )
}

/**
 * A URL in text: the base, then the query up to the first `]`. A URL starts
 * at a scheme (`https://`, `postgres://`), at `www.`, at a host with no
 * scheme and a `/`, `?`, or `#` after it (`app.example.com/`,
 * `example.com:8443?`), at `//` before a word character (`//intranet/`), or at
 * a path that starts with `/` after a space or an opening mark (a relative
 * link). The base ends at a space, `<`, `>`, `?`, or `#`. The query and the
 * fragment end at a space, `<`, or `>`; `replaceUrls` continues them past a
 * `]`. In Markdown, a backtick also ends a URL, so that the redaction cannot
 * remove the end of a code span. A scheme match starts once for each run of
 * scheme characters, so a long run costs linear time; the run can start with
 * a digit or a mark (`1https://`, `...https://`), and these stay before the
 * scheme.
 */
const urlPattern = (stop: string) =>
  new RegExp(
    String.raw`(?:(?<![a-z0-9+.-])[a-z0-9+.-]+:\/\/|(?<![a-z0-9])www\.|(?<![\w.@/-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?=[/?#])|(?<![\w:/])\/\/(?=[\w-])|(?<![^\s(["'<>=])\/(?=[\w%-]))[^\s<>?#${stop}]*(?:[?#][^\s<>\]${stop}]*)?`,
    "gi",
  )

/**
 * The text with each URL replaced by `replace`. A query goes on past each
 * `]` that is not the `](` of a link, and ends before the `](` or `\](`, so
 * that a URL in a link label does not take the link target or its escape.
 * The loop finds that end: a lookahead in a repeated group needs one V8
 * backtrack frame for each character, and 5,000,000 frames overflow the
 * stack. Each character is read once, so the cost is linear.
 */
function replaceUrls(
  text: string,
  to: Output,
  replace: (url: string) => string,
): string {
  const urls = new RegExp(to.url)
  const rest = new RegExp(`[^\\s<>\\]${to.stop}]*`, "y")
  let out = ""
  let copied = 0
  for (let match = urls.exec(text); match; match = urls.exec(text)) {
    const query = match.index + match[0].search(/[?#]|$/)
    let end = match.index + match[0].length
    if (query < end) {
      while (text.charAt(end) === "]" && text.charAt(end + 1) !== "(") {
        rest.lastIndex = end + 1
        rest.exec(text)
        end = rest.lastIndex
      }
      if (text.startsWith("\\](", end - 1) && end - 1 > query) end -= 1
    }
    out += `${text.slice(copied, match.index)}${replace(text.slice(match.index, end))}`
    copied = end
    urls.lastIndex = end
  }
  return out + text.slice(copied)
}

/**
 * The `\` before `end` when it escapes the character at `end`: the last of a
 * run of backslashes with an odd length. The redaction keeps it, so that a
 * removed URL or value does not make the next mark live (`\``, `\]`).
 */
function escapeAt(text: string, end: number): string {
  let start = end
  while (start > 0 && text.charAt(start - 1) === "\\") start -= 1
  return (end - start) % 2 === 1 ? "\\" : ""
}

/**
 * The marks at the end of a URL that belong to the text around it, with the
 * `\` that escapes the first of them.
 */
function endMarksOf(text: string): string {
  let start = text.length
  while (start > 0 && `)]}.,;:!?'"*_`.includes(text.charAt(start - 1)))
    start -= 1
  return `${escapeAt(text, start)}${text.slice(start)}`
}

/** A path segment named `token` holds the token in the next segment. */
const hasTokenPath = (path: string) => /\/token\/[^/]/i.test(path)

/**
 * Text in which each userinfo of a URL (`user:password@`) becomes a marker.
 * A userinfo runs up to the last `@` before a `/`, a space, `<`, or `>`, and
 * it starts at one of these:
 * - `//`, also in a URL that starts inside another URL
 *   (`https://a.example/x**https://user:pass@evil.example/**`);
 * - `www.`: GFM links `www.user:pass@evil.example` to
 *   `http://www.user:pass@evil.example`, where `www.user:pass` is the
 *   userinfo;
 * - the start of a run with no scheme (`user:pass@host.example/`). This
 *   userinfo needs a `:` and a host with a `/`, `?`, or `#` after it, so that
 *   an email address stays.
 * A match starts only at the start of a run, so the cost is linear.
 */
function withoutUserinfos(text: string, to: Output): string {
  const stop = `\\s/<>${to.stop}`
  return text.replace(
    new RegExp(`(?<![^${stop}])[^${stop}]+@`, "g"),
    (match: string, offset: number) => {
      const www = match.search(/(?<![a-z0-9])www\./i)
      const lead = /^[^\w%]*/.exec(match)?.[0] ?? ""
      const start = text.startsWith("//", offset - 2)
        ? 0
        : www >= 0
          ? www
          : match.includes(":", lead.length) &&
              !/^mailto:/i.test(match.slice(lead.length)) &&
              /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#]/i.test(
                text.slice(offset + match.length, offset + match.length + 320),
              )
            ? lead.length
            : -1
      return start < 0
        ? match
        : `${match.slice(0, start)}${to.mark("credentials removed")}@`
    },
  )
}

/**
 * Whether a URL carries a credential: a userinfo, a path segment named
 * `token`, or a parameter with a credential name anywhere in the URL (also
 * in a fragment route, `#/route?token=`). The check decodes ASCII
 * percent-escapes three times, so `%74oken` and `%3Ftoken%3D` are found.
 */
function hasCredential(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, "https://base.invalid/")
  } catch {
    return true
  }
  let decoded = url
  for (let pass = 0; pass < 3; pass += 1)
    decoded = decoded.replace(/%([0-7][\da-f])/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
  return (
    parsed.username !== "" ||
    parsed.password !== "" ||
    hasTokenPath(parsed.pathname) ||
    new RegExp(`(?<![\\w.-])(?:${credentialName})=`, "i").test(decoded)
  )
}

/**
 * Text in which each URL has no userinfo, no query, and no fragment. The
 * userinfo goes first, from the whole URL, so that a `#` or `?` in a
 * password does not keep part of it. The query of a URL can hold any
 * credential, so no list of names decides. A
 * URL with a path segment named `token` goes as a whole. A URL with another
 * scheme than https keeps its scheme, host, and path: they hold no
 * credential, and a reader can need them (`http://localhost:3000/app`).
 */
function withoutUrlQueries(text: string, to: Output): string {
  const { mark } = to
  return replaceUrls(text, to, (url) => {
    const kept = withoutUserinfos(url, to)
    const query = kept.search(/[?#]/)
    const base = query < 0 ? kept : kept.slice(0, query)
    if (hasTokenPath(base)) return `${mark("link removed")}${endMarksOf(url)}`
    if (query < 0) return kept
    // A `\` that escapes the `?` or `#` goes with the query, so that it
    // cannot escape the `\` that `endMarksOf` keeps.
    const escape = escapeAt(base, base.length)
    return `${base.slice(0, base.length - escape.length)}${endMarksOf(kept.slice(query))}`
  })
}

/**
 * Text in which each URL that carries a credential, or that has another
 * scheme than https, becomes a marker. Other URLs stay as they are.
 */
function withoutCredentialUrls(text: string, to: Output): string {
  const { mark } = to
  return replaceUrls(text, to, (match) => {
    const marks = endMarksOf(match)
    const lead = /^[^a-z/]*(?=[a-z][a-z0-9+.-]*:\/\/)/i.exec(match)?.[0] ?? ""
    const url = match.slice(lead.length, match.length - marks.length)
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase()
    // GFM reads a `www.` URL as `http://www.…`, so its userinfo is found.
    const target = /^www\./i.test(url) ? `http://${url}` : url
    return (scheme === undefined || scheme === "https") &&
      !hasCredential(target)
      ? match
      : `${lead}${mark("link removed")}${marks}`
  })
}

/** Writes a redaction marker, such as `[email removed]`. */
type Marker = (name: string) => string

/**
 * How the redaction writes into the text: its marker, the stop characters of
 * a URL and a credential value, and the URL pattern with those stops.
 */
type Output = { mark: Marker; stop: string; url: RegExp }

/**
 * Text that is escaped later (a body, a line). A backtick does not stop the
 * redaction: no link can form, because `[` and `<` are escaped.
 */
const plainText: Output = {
  mark: (name) => `[${name}]`,
  stop: "",
  url: urlPattern(""),
}

/**
 * Markdown that stays live (an article). The markers are escaped as they are
 * written, and a backtick stops the redaction, so that code spans stay
 * paired.
 */
const liveMarkdown: Output = {
  mark: (name) => `\\[${name}\\]`,
  stop: "`",
  url: urlPattern("`"),
}

/**
 * The rules for a Help Center article body. The support team writes an
 * article, and an article is often public, so the policy is an open
 * decision (CTX-840); each connector keeps its current rule until then.
 * - `credential-links`: remove each URL that carries a credential or has
 *   another scheme than https (Plain).
 * - `queries`: remove the query, the fragment, and the userinfo of each URL;
 *   keep addresses and phone numbers.
 * - `full`: the ticket rules (Zendesk).
 * Each policy also removes credential parameters in text.
 */
export type ArticlePolicy = "credential-links" | "queries" | "full"

/**
 * The redaction, in the order that the security rule needs: URLs first, so
 * that a userinfo is not an address; then each userinfo that the URL pass
 * kept (in a URL inside another URL, or with no scheme); then credential
 * parameters outside a URL; then addresses and phone numbers.
 */
function redacted(text: string, policy: ArticlePolicy, to: Output): string {
  const linked = withoutUserinfos(
    policy === "credential-links"
      ? withoutCredentialUrls(text, to)
      : withoutUrlQueries(text, to),
    to,
  )
  const safe = withoutCredentialParameters(linked, to)
  return policy === "full"
    ? withoutPhones(withoutEmails(safe, to.mark), to.mark)
    : safe
}

/**
 * The start of the text, at most `maxChars` characters long. This is the one
 * cut, and it comes before the redaction, so the redaction reads at most
 * `maxChars` characters and every address, phone number, and URL that it
 * reads is whole. A cut after the redaction could split a marker or need a
 * second cut, and the input has no bound.
 *
 * The cut moves back to the last space or line end, so that no part of a
 * word stays; it looks back at most 2,100 characters. When that range has no
 * space (Chinese or Japanese text, or one long token), the cut moves back
 * over at most 320 characters that can be in an address or a URL (ASCII
 * marks, `。`, `−`, letters, marks, digits). An address has at most 320
 * characters. Last,
 * the cut moves back over phone characters, so that no part of a phone number
 * stays, and it does not split a surrogate pair. Each loop is linear.
 */
function cutAt(text: string, maxChars: number): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false }
  const head = text.slice(0, maxChars)
  const floor = Math.max(0, head.length - 2_100)
  let end = head.length
  while (end > floor && !/\s/.test(head.charAt(end - 1))) end -= 1
  if (!/\s/.test(head.charAt(end - 1))) {
    const stop = Math.max(0, head.length - 320)
    end = head.length
    while (end > stop && /[!-~。−\p{L}\p{M}\p{N}]/u.test(head.charAt(end - 1)))
      end -= 1
  }
  while (end > 0 && /[\d\s().+\p{Pd}−]/u.test(head.charAt(end - 1))) end -= 1
  if (/[\uD800-\uDBFF]/.test(head.charAt(end - 1))) end -= 1
  return { text: head.slice(0, end), cut: true }
}

/** A node of a Markdown tree, with the fields that the checks read. */
type MarkdownNode = {
  type: string
  url?: string
  value?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/**
 * The CommonMark tree of the Markdown, or the GFM tree when `github` is true,
 * or `null` when the parser fails (deep nesting overflows the stack).
 * Emphasis and strikethrough cannot change a link (links bind first), so
 * the parser skips them: on `*a*a…` and `~a~a…` they cost quadratic time.
 */
function parsed(markdown: string, github = false): MarkdownNode | null {
  try {
    return fromMarkdown(markdown, {
      extensions: [
        ...(github ? [gfm()] : []),
        { disable: { null: ["attention", "strikethrough"] } },
      ],
      mdastExtensions: github ? [gfmFromMarkdown()] : [],
    })
  } catch {
    return null
  }
}

/** Each node of the tree. A loop, not a recursion: a deep tree overflows the stack. */
function* nodesOf(tree: MarkdownNode): Generator<MarkdownNode> {
  const nodes = [tree]
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    yield node
    if (node.children) nodes.push(...node.children)
  }
}

/** The start and end offsets of each code span and code block of the tree. */
function codeRangesOf(tree: MarkdownNode): [number, number][] {
  const ranges: [number, number][] = []
  for (const node of nodesOf(tree))
    if ((node.type === "code" || node.type === "inlineCode") && node.position)
      ranges.push([
        node.position.start.offset ?? 0,
        node.position.end.offset ?? 0,
      ])
  return ranges
}

/**
 * Whether a GFM link is a literal autolink that can stay: its text is the
 * URL as the reader sees it (`http://…`, `https://…`, `www.…`, or an email
 * address), its scheme is http, https, or mailto, and it has no credential.
 * Its target is then the visible, redacted text. GFM makes no literal
 * autolink with another scheme. It must not start in a CommonMark code span
 * or code block: there, the two parsers do not agree (a `|` in a code span
 * on a table row breaks the span in GFM), and CommonMark shows it as code.
 */
function isAllowedAutolink(
  node: MarkdownNode,
  code: [number, number][],
): boolean {
  const [text] = node.children ?? []
  const start = node.position?.start.offset
  return (
    node.type === "link" &&
    node.children?.length === 1 &&
    text?.type === "text" &&
    node.url !== undefined &&
    [text.value, `http://${text.value}`, `mailto:${text.value}`].includes(
      node.url,
    ) &&
    /^(?:https?|mailto):/i.test(node.url) &&
    !hasAutolinkCredential(node.url) &&
    start !== undefined &&
    !code.some(([from, to]) => start >= from && start < to)
  )
}

/**
 * Whether a literal autolink carries a credential. Its host can hold text
 * that the URL parser rejects (`https://x.com)＜b＞`), so the check reads a
 * userinfo as an `@` before the path, and checks the rest of the URL with a
 * valid host.
 */
function hasAutolinkCredential(url: string): boolean {
  const authority = /^[a-z]+:\/\/[^/?#]*/i.exec(url)?.[0]
  if (!authority) return hasCredential(url)
  return (
    authority.includes("@") ||
    hasCredential(`https://host.invalid${url.slice(authority.length)}`)
  )
}

/**
 * Whether the parser check can read the Markdown in a bounded time: at most
 * 200,000 characters, and an estimated parse time (`parseCost`) of at most
 * 2 seconds. The parsers cost more than linear time on some constructs, so
 * the length alone is not a bound. A long normal article (headings,
 * paragraphs, lists, tables, code blocks, and links) of 200,000 characters
 * has an estimate of 0.4 to 0.6 seconds, and its parses take about 0.2
 * seconds. Each hostile shape that passes takes at most about 3 seconds
 * (Node 26, slow JIT state).
 */
function isParseable(markdown: string): boolean {
  return markdown.length <= 200_000 && parseCost(markdown) <= 2e9
}

/**
 * An estimate of the time that the two parses of the parser check take, in
 * nanoseconds on Node 26 in a process that parsed other text before (the
 * slow JIT state). Each term is one construct that costs more than linear
 * time in micromark 4 and its GFM extensions, with a weight from
 * measurements. Each term is larger than the cost of its construct. A unit
 * is a run of lines with no blank line: no paragraph or table crosses a
 * blank line.
 * - Each list item adds events to one array of the whole text.
 * - The GFM search for an email address reads a run of word characters
 *   again from each `-`, `.`, `_`, or `+` in it.
 * - A `]` that is not part of a simple link (`[text](url)`) walks
 *   back through its paragraph to find its opening. A `[` that is not part
 *   of a simple link makes each later word walk back to it. A simple link
 *   has no mark in its text that can hide one of its brackets (a backtick,
 *   `<`, `>`, a parenthesis, or `|`), so the parser pairs its brackets.
 * - Each bracket, escape, character reference, and code span makes the
 *   parser merge the rest of its paragraph again. Each `<` (an unclosed
 *   `<?` or `<!--`) scans the rest of its paragraph.
 * - Each line of a unit can be a lazy line of a list item or a quote.
 * - Each block costs about 30 microseconds.
 * - The container marks at the start of a line (spaces, tabs, `>`, and list
 *   marks such as `-` and `1.`) can nest the line one level deeper for each
 *   mark or each indent, also with no mark on the same line. Each line costs
 *   the square of the columns of these marks. This is also a hard cap that
 *   needs no estimate: a line with more than 128 columns of container marks
 *   makes the cost infinite. node-html-markdown writes a list of depth 8 with
 *   at most 88 columns, and of depth 10 with 137.
 * - The GFM search for a literal autolink reads the rest of a run with no
 *   space again from each `http://`, `https://`, or `www.` in it, also when
 *   it is not a link (`ahttp://`).
 * - Each table cell adds an edit to one list of the whole text.
 */
function parseCost(text: string): number {
  const markdown = text.replace(/\r\n?/g, "\n")
  const count = (part: string, marks: RegExp) => part.match(marks)?.length ?? 0
  let cost =
    1.5 *
    count(markdown, /^[ \t>]*(?:[*+-]|\d{1,9}[.)])(?=[ \t]|$)/gm) *
    markdown.length
  for (const [run] of markdown.matchAll(/[-.\w+]{2,}/g))
    cost += 0.6 * run.length * count(run, /[-.+_]/g)
  for (const [run] of markdown.matchAll(/[^ \t\n]+/g))
    cost += 0.6 * run.length * count(run, /https?:\/\/|www\./gi)
  for (const [lead] of markdown.matchAll(
    /^(?:[ \t>]|(?:[*+-]|\d{1,9}[.)])(?=[ \t]|$))+/gm,
  )) {
    let columns = 0
    for (const mark of lead)
      columns = mark === "\t" ? columns + 4 - (columns % 4) : columns + 1
    if (columns > 128) return Number.POSITIVE_INFINITY
    cost += 300 * columns ** 2
  }
  let cells = 0
  for (const unit of markdown.split(/\n[ \t]*\n/)) {
    let open = false
    for (const mark of unit.matchAll(
      /\\[\s\S]|!?\[(?!\^)(?:[^\\[\]`<>()|\n]|\\[!-/:-@[-`{-~]){0,1000}\]\([^\s\\`<>()[\]]*(?: "[^"\\\n]*")?\)|[[\]]/g,
    )) {
      if (mark[0] === "]") cost += 60 * mark.index
      if (mark[0] === "[") open = true
    }
    const lines = count(unit, /\n/g) + 1
    cost +=
      30_000 +
      25 * lines ** 2 +
      (open ? 3 * unit.length ** 2 : 0) +
      unit.length * (1.5 * count(unit, /[\\&`[\]]/g) + 12 * count(unit, /</g))
    if (unit.includes("|")) cells += count(unit, /\|/g) + lines
  }
  return cost + 10 * cells ** 2
}

/**
 * Whether a CommonMark or a GFM parser finds a live node in the Markdown:
 * HTML, or a link, image, autolink, or definition whose target is not https
 * or carries a credential. A GFM literal autolink can also have an http or
 * mailto target (`isAllowedAutolink`). Each entry point runs this check on
 * its result, as the safety net after the rules above: the parsers read the
 * text as a renderer does, so the check does not depend on a regex edge
 * case. A converter can also call it on a whole file.
 *
 * Text with no `[`, `<`, `@`, `://`, or `www.` cannot have one of these
 * nodes, so it is not parsed. The parsers skip emphasis and strikethrough
 * (see `parsed`). Text that `isParseable` rejects is not parsed and counts
 * as unsafe. A parser error (deep nesting overflows the stack; the GFM
 * parser overflows at 8,000 nested quotes) also counts as unsafe.
 */
export function isUnsafeMarkdown(markdown: string): boolean {
  if (!/[[<@]|:\/\/|www\./i.test(markdown)) return false
  if (!isParseable(markdown)) return true
  const commonMark = parsed(markdown)
  const github = parsed(markdown, true)
  if (!commonMark || !github) return true
  const code = codeRangesOf(commonMark)
  for (const tree of [commonMark, github])
    for (const node of nodesOf(tree)) {
      if (node.type === "html") return true
      if (
        typeof node.url === "string" &&
        (!/^https:\/\//i.test(node.url) || hasCredential(node.url)) &&
        !(tree === github && isAllowedAutolink(node, code))
      )
        return true
    }
  return false
}

/**
 * The result when the parser check finds a live node: the redacted text with
 * a `\` before each ASCII punctuation character, so that no Markdown
 * construct can start. A `\` that already escapes a punctuation character
 * stays with it (the `\[removed\]` marker of an article). The text is inert
 * by construction, and it is still redacted.
 */
function inert(text: string): string {
  return text.replace(/\\?[!-/:-@[-`{-~]/g, (mark) =>
    mark.length === 2 ? mark : `\\${mark}`,
  )
}

/**
 * A body of customer text (a message, a comment): stripped, cut, redacted,
 * and escaped, in that order. A line that would be a heading or a heading
 * underline is escaped. When the parser check finds a live node, the text is
 * the inert fallback. The text has only line feeds as line ends.
 * `cut` is true when the text was longer than `maxChars`.
 */
export function customerText(
  text: string,
  opts: { maxChars: number },
): { text: string; cut: boolean } {
  const head = cutAt(
    stripped(text)
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .trim(),
    opts.maxChars,
  )
  const safe = redacted(head.text, "full", plainText)
  const quoted = escaped(safe, /\\(?=[\\[\]<>]|$)|[[\]<>]/g).replace(
    /^([ \t]*)(#|[=-]+[ \t]*$)/gm,
    "$1\\$2",
  )
  return {
    text: isUnsafeMarkdown(quoted) ? inert(safe) : quoted,
    cut: head.cut,
  }
}

/**
 * A one-line field of customer text (a title, a name, a tag, a status). Each
 * run of spaces, tabs, and line ends becomes one space before the redaction,
 * so that a line break cannot split a phone number. A field that was longer
 * than `maxChars` ends with `…`. A backtick is escaped too, because a field
 * can go into live Markdown (an image alt in an article). The result is safe
 * inside a Markdown line, but not at the start of one.
 */
export function customerLine(text: string, opts: { maxChars: number }): string {
  const { safe, cut } = redactedLine(text, opts.maxChars)
  const line = escaped(safe, /\\(?=[\\[\]<>`]|$)|[[\]<>`]/g)
  return `${isUnsafeMarkdown(line) ? inert(safe) : line}${cut ? "…" : ""}`
}

/**
 * A one-line field of customer text for a place that is not Markdown, for
 * example a file name: the same strip, cut, and redaction as `customerLine`,
 * with no Markdown escape. Do not put the result into Markdown.
 */
export function customerPlainLine(
  text: string,
  opts: { maxChars: number },
): string {
  const { safe, cut } = redactedLine(text, opts.maxChars)
  return `${safe}${cut ? "…" : ""}`
}

/** The strip, the cut, and the redaction of a one-line field. */
function redactedLine(text: string, maxChars: number) {
  const head = cutAt(stripped(text).replace(/\s+/g, " ").trim(), maxChars)
  return { safe: redacted(head.text, "full", plainText), cut: head.cut }
}

/**
 * The target of an article link, or `null` when the link keeps only its
 * text. The converter's link translator calls this for each `href`. Only an
 * absolute https link with no userinfo and no path segment named `token`
 * stays: a relative link has no meaning in git. `credential-links` drops a
 * link with a credential parameter; the other policies remove the query and
 * the fragment. A space, a bracket, an angle bracket, or a backslash is
 * percent-encoded, so that it cannot end the link. The check runs again on
 * the encoded link: the URL parser reads `\` as `/`, but `%5C` can be part
 * of a userinfo. `&` becomes `&amp;`, because the Markdown renderer decodes
 * character references: `&commat;` would become `@` after the check. A link
 * longer than 8,192 characters keeps only its text: the encoding makes a
 * link up to five times longer.
 */
export function safeHref(href: string, policy: ArticlePolicy): string | null {
  const url = stripped(href).trim()
  if (url.length > 8_192) return null
  const query = url.search(/[?#]/)
  const kept =
    policy === "credential-links" || query < 0 ? url : url.slice(0, query)
  const encoded = kept.replace(/[\s()<>\\&]/g, (mark) =>
    mark === "&"
      ? "&amp;"
      : mark === "("
        ? "%28"
        : mark === ")"
          ? "%29"
          : encodeURIComponent(mark),
  )
  return /^https:\/\//i.test(kept) &&
    !hasCredential(kept) &&
    !hasCredential(encoded)
    ? encoded
    : null
}

/**
 * Article Markdown in which each `<` and `>` in text is `&lt;` and `&gt;`.
 * The article converter writes a tag that the article shows as text
 * (`&lt;div&gt;` in its HTML) as a raw `<div>`, and the parser check would
 * then make the whole article inert. Real HTML cannot come from the
 * converter, because it converts or drops each tag.
 *
 * A code span and a code block stay as they are: code does not decode a
 * character reference, and no HTML can form in it. The parser gives their
 * positions. A `>` in the marks at the start of a line (a quote, in a list
 * item or not) also stays. A `\` that escapes the mark goes, because
 * `&lt;` is already literal and a `\` before it would escape the `&`.
 *
 * Text with no `<` cannot form HTML or an autolink, so it is not parsed.
 * Text that the parser check cannot read in a bounded time (`isParseable`)
 * is not parsed either: it becomes the inert fallback. When the escape
 * changes how the code spans pair, the parser check still reads the result.
 */
function withTextTags(markdown: string): string {
  if (!markdown.includes("<") || !isParseable(markdown)) return markdown
  const tree = parsed(markdown)
  if (!tree) return markdown
  const kept = codeRangesOf(tree)
  for (const marks of markdown.matchAll(
    /^(?:[ \t]*(?:>|[*+-][ \t]|\d{1,9}[.)][ \t]))+/gm,
  ))
    kept.push([marks.index, marks.index + marks[0].length])
  kept.sort((a, b) => a[0] - b[0])
  kept.push([markdown.length, markdown.length])
  let out = ""
  let copied = 0
  for (const [start, end] of kept) {
    // A match starts only at the start of a run of backslashes, so that a
    // long run costs linear time.
    if (start > copied)
      out += markdown
        .slice(copied, start)
        .replace(/(?<!\\)(\\*)([<>])/g, (_match, slashes: string, mark) => {
          const pairs = slashes.slice(slashes.length % 2)
          return `${pairs}${mark === "<" ? "&lt;" : "&gt;"}`
        })
    out += markdown.slice(Math.max(copied, start), Math.max(copied, end))
    copied = Math.max(copied, end)
  }
  return out
}

/**
 * An article body as Markdown, after the converter made it from HTML with
 * `safeHref` for each link: stripped and redacted by the policy, with each
 * `<` and `>` in text as a character reference (`withTextTags`). The
 * Markdown stays live, so each marker is escaped as it is written. When the
 * parser check finds a live node (HTML, a link that is not https), or it
 * cannot read the article in a bounded time (`isParseable`), the whole
 * article is the inert fallback.
 */
export function articleText(markdown: string, policy: ArticlePolicy): string {
  const safe = withTextTags(redacted(stripped(markdown), policy, liveMarkdown))
  return isUnsafeMarkdown(safe) ? inert(safe) : safe
}
