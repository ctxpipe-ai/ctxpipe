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
  label: string
  identifier: string
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
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined
  }
  return trimmed
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

    if (node.type !== "linkReference" || !node.identifier) return
    const resolved = definitions.get(node.identifier)
    if (!resolved) return
    const url = normalizeHttpUrl(resolved.url)
    if (!url) return
    const label =
      phrasingText(node).trim() || node.label?.trim() || node.identifier
    links.push({
      start: span.start,
      end: span.end,
      source: markdown.slice(span.start, span.end),
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
  const edits: MarkdownEdit[] = []
  const capturedIdentifiers = new Set<string>()

  for (const image of parsed.images) {
    const next = replaceImage(image)
    if (next === image.source) continue
    edits.push({ start: image.start, end: image.end, text: next })
    if (image.identifier) capturedIdentifiers.add(image.identifier)
  }

  for (const link of parsed.links) {
    if (!capturedIdentifiers.has(link.identifier)) continue
    const next = replaceLink(link)
    if (next === link.source) continue
    edits.push({ start: link.start, end: link.end, text: next })
  }

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
