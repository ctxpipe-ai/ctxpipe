import { fromMarkdown } from "mdast-util-from-markdown"

export type LinearMarkdownImage = {
  start: number
  end: number
  source: string
  alt: string
  url: string
  identifier?: string
  definition?: {
    start: number
    end: number
  }
}

export type LinearMarkdownLinkReference = {
  start: number
  end: number
  source: string
  content?: string
  contentStart?: number
  contentEnd?: number
  containsImage: boolean
  label: string
  identifier?: string
  url: string
}

type MdastNode = {
  type: string
  alt?: string | null
  identifier?: string
  label?: string | null
  url?: string
  value?: string
  children?: MdastNode[]
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

type MarkdownSpan = {
  start: number
  end: number
}

type MarkdownEdit = MarkdownSpan & { text: string }

type ResolvedDefinition = {
  url: string
  spans: MarkdownSpan[]
}

function normalizeHttpUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined
  }
  return candidate
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(
      `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  )
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function walkMdast(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walkMdast(child, visit)
}

function sourceSpan(node: MdastNode): MarkdownSpan | undefined {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (start == null || end == null || end <= start) return undefined
  return { start, end }
}

function phrasingText(node: MdastNode): string {
  if (
    node.value != null &&
    (node.children == null || node.children.length === 0)
  ) {
    return node.value
  }
  return (node.children ?? []).map(phrasingText).join("")
}

function childContentSpan(node: MdastNode): MarkdownSpan | undefined {
  const spans = (node.children ?? [])
    .map(sourceSpan)
    .filter((span) => span !== undefined)
  const first = spans[0]
  const last = spans.at(-1)
  return first && last ? { start: first.start, end: last.end } : undefined
}

function containsImage(node: MdastNode): boolean {
  if (node.type === "image" || node.type === "imageReference") return true
  if (node.type === "html" && /<img\b/i.test(node.value ?? "")) return true
  return (node.children ?? []).some(containsImage)
}

function followingLineEnding(markdown: string, index: number): number {
  if (markdown.startsWith("\r\n", index)) return index + 2
  if (markdown[index] === "\n") return index + 1
  return index
}

function precedingLineEnding(markdown: string, index: number): number {
  if (index >= 2 && markdown.startsWith("\r\n", index - 2)) return index - 2
  if (index >= 1 && markdown[index - 1] === "\n") return index - 1
  return index
}

function definitionRemovalSpans(
  markdown: string,
  spans: readonly MarkdownSpan[],
): MarkdownSpan[] {
  const merged: MarkdownSpan[] = []
  for (const span of [...spans].sort(
    (left, right) => left.start - right.start,
  )) {
    const next = {
      start: span.start,
      end: followingLineEnding(markdown, span.end),
    }
    const last = merged.at(-1)
    if (last && next.start <= last.end) {
      last.end = Math.max(last.end, next.end)
      continue
    }
    merged.push(next)
  }

  const last = merged.at(-1)
  if (last && markdown.slice(last.end).trim() === "") {
    last.end = markdown.length
    const afterBlank = precedingLineEnding(markdown, last.start)
    if (
      afterBlank !== last.start &&
      precedingLineEnding(markdown, afterBlank) !== afterBlank
    ) {
      last.start = afterBlank
    }
  }
  return merged
}

function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start)
  let output = markdown
  let consumedThrough = output.length
  for (const edit of ordered) {
    if (edit.end > consumedThrough) continue
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
    consumedThrough = edit.start
  }
  return output
}

function parseLinearMarkdownReferences(markdown: string): {
  images: LinearMarkdownImage[]
  links: LinearMarkdownLinkReference[]
  definitions: Map<string, ResolvedDefinition>
} {
  const tree = fromMarkdown(markdown) as MdastNode
  const definitions = new Map<string, ResolvedDefinition>()
  walkMdast(tree, (node) => {
    if (node.type !== "definition" || !node.identifier || node.url == null) {
      return
    }
    const span = sourceSpan(node)
    if (!span) return
    const existing = definitions.get(node.identifier)
    if (existing) {
      existing.spans.push(span)
      return
    }
    definitions.set(node.identifier, { url: node.url, spans: [span] })
  })

  const images: LinearMarkdownImage[] = []
  const links: LinearMarkdownLinkReference[] = []
  walkMdast(tree, (node) => {
    const span = sourceSpan(node)
    if (!span) return

    if (node.type === "image") {
      const url = normalizeHttpUrl(node.url ?? "")
      if (!url) return
      images.push({
        start: span.start,
        end: span.end,
        source: markdown.slice(span.start, span.end),
        alt: node.alt ?? "",
        url,
      })
      return
    }

    if (node.type === "imageReference" && node.identifier) {
      const resolved = definitions.get(node.identifier)
      if (!resolved) return
      const url = normalizeHttpUrl(resolved.url)
      if (!url) return
      const first = resolved.spans[0]
      images.push({
        start: span.start,
        end: span.end,
        source: markdown.slice(span.start, span.end),
        alt: node.alt ?? "",
        url,
        identifier: node.identifier,
        definition: first,
      })
      return
    }

    if (node.type === "html" && node.value) {
      for (const match of node.value.matchAll(
        /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
      )) {
        if (match.index === undefined) continue
        const url = normalizeHttpUrl(htmlAttribute(match[0], "src") ?? "")
        if (!url) continue
        const start = span.start + match.index
        const end = start + match[0].length
        images.push({
          start,
          end,
          source: markdown.slice(start, end),
          alt: htmlAttribute(match[0], "alt") ?? "",
          url,
        })
      }
      return
    }

    if (node.type === "link") {
      const url = normalizeHttpUrl(node.url ?? "")
      if (!url) return
      const contentSpan = childContentSpan(node)
      links.push({
        start: span.start,
        end: span.end,
        source: markdown.slice(span.start, span.end),
        ...(contentSpan
          ? {
              content: markdown.slice(contentSpan.start, contentSpan.end),
              contentStart: contentSpan.start,
              contentEnd: contentSpan.end,
            }
          : {}),
        containsImage: containsImage(node),
        label: phrasingText(node).trim() || "link",
        url,
      })
      return
    }

    if (node.type !== "linkReference" || !node.identifier) return
    const resolved = definitions.get(node.identifier)
    if (!resolved) return
    const url = normalizeHttpUrl(resolved.url)
    if (!url) return
    const label =
      phrasingText(node).trim() || node.label?.trim() || node.identifier
    const contentSpan = childContentSpan(node)
    links.push({
      start: span.start,
      end: span.end,
      source: markdown.slice(span.start, span.end),
      ...(contentSpan
        ? {
            content: markdown.slice(contentSpan.start, contentSpan.end),
            contentStart: contentSpan.start,
            contentEnd: contentSpan.end,
          }
        : {}),
      containsImage: containsImage(node),
      label,
      identifier: node.identifier,
      url,
    })
  })

  return { images, links, definitions }
}

export function rewriteLinearMarkdownImages(
  markdown: string,
  replaceImage: (image: LinearMarkdownImage) => string,
  replaceLink: (link: LinearMarkdownLinkReference) => string = (link) =>
    link.source,
): string {
  const parsed = parseLinearMarkdownReferences(markdown)
  const imageEdits: MarkdownEdit[] = []
  const linkEdits: MarkdownEdit[] = []
  const suppressedImageEdits = new Set<MarkdownEdit>()
  const capturedIdentifiers = new Set<string>()

  for (const image of parsed.images) {
    const next = replaceImage(image)
    if (next === image.source) continue
    imageEdits.push({ start: image.start, end: image.end, text: next })
    if (image.identifier) capturedIdentifiers.add(image.identifier)
  }

  for (const link of parsed.links) {
    const nestedImageEdits = imageEdits.filter(
      (edit) => edit.start >= link.start && edit.end <= link.end,
    )
    const contentStart = link.contentStart
    const contentEnd = link.contentEnd
    const rewrittenContent =
      link.content !== undefined &&
      contentStart !== undefined &&
      contentEnd !== undefined
        ? applyMarkdownEdits(
            link.content,
            nestedImageEdits
              .filter(
                (edit) => edit.start >= contentStart && edit.end <= contentEnd,
              )
              .map((edit) => ({
                ...edit,
                start: edit.start - contentStart,
                end: edit.end - contentStart,
              })),
          )
        : undefined
    const rewrittenLink = {
      ...link,
      source: applyMarkdownEdits(
        link.source,
        nestedImageEdits.map((edit) => ({
          ...edit,
          start: edit.start - link.start,
          end: edit.end - link.start,
        })),
      ),
      ...(rewrittenContent !== undefined ? { content: rewrittenContent } : {}),
    }
    const next = replaceLink(rewrittenLink)
    if (next === rewrittenLink.source) continue
    for (const edit of nestedImageEdits) suppressedImageEdits.add(edit)
    linkEdits.push({ start: link.start, end: link.end, text: next })
    if (link.identifier) capturedIdentifiers.add(link.identifier)
  }

  const edits = [
    ...imageEdits.filter((edit) => !suppressedImageEdits.has(edit)),
    ...linkEdits,
  ]
  for (const identifier of capturedIdentifiers) {
    const resolved = parsed.definitions.get(identifier)
    if (!resolved) continue
    for (const removal of definitionRemovalSpans(markdown, resolved.spans)) {
      edits.push({ ...removal, text: "" })
    }
  }

  return applyMarkdownEdits(markdown, edits)
}

export function scanLinearMarkdownImages(
  markdown: string,
): LinearMarkdownImage[] {
  return parseLinearMarkdownReferences(markdown).images
}

export function scanLinearMarkdownLinks(
  markdown: string,
): LinearMarkdownLinkReference[] {
  return parseLinearMarkdownReferences(markdown).links
}
