import { fromMarkdown } from "mdast-util-from-markdown"

/** The text of a Markdown file after its front matter. */
export function markdownBodyOf(content: string): string {
  return (
    /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?=\r?\n|$)([\s\S]*)$/.exec(
      content,
    )?.[1] ?? content
  )
}

/**
 * The content with each edit applied to its body. Each edit is a range of
 * the body (`markdownBodyOf`) and its new text. The front matter stays.
 */
export function applyBodyEdits(
  content: string,
  edits: readonly { start: number; end: number; value: string }[],
): string {
  const body = markdownBodyOf(content)
  let next = body
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.value + next.slice(edit.end)
  return content.slice(0, content.length - body.length) + next
}

/**
 * The destination of each link, image and link definition of a Markdown
 * body, with its position. Code spans and fenced code give none.
 */
export function markdownDestinations(body: string) {
  const links: Array<{
    url: string
    start: number
    end: number
  }> = []
  const tree = fromMarkdown(body)
  const visit = (node: (typeof tree.children)[number]) => {
    if (
      node.type === "link" ||
      node.type === "image" ||
      node.type === "definition"
    ) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) {
        const source = body.slice(start, end)
        const span = destinationSpan(source, node.type === "definition")
        if (span)
          links.push({
            url: node.url,
            start: start + span.start,
            end: start + span.end,
          })
      }
    }
    if ("children" in node) for (const child of node.children) visit(child)
  }
  for (const node of tree.children) visit(node)
  return links
}

/** Positions come from the Markdown parser; scan only an already recognized link/definition. */
function destinationSpan(
  source: string,
  definition: boolean,
): { start: number; end: number } | null {
  let cursor = source.startsWith("![") ? 2 : source.startsWith("[") ? 1 : -1
  if (cursor < 0) return null
  let brackets = 1
  while (cursor < source.length && brackets) {
    const character = source[cursor++]
    if (character === "\\") cursor++
    else if (character === "[") brackets++
    else if (character === "]") brackets--
    else if (character === "`" && !definition) {
      let length = 1
      while (source[cursor] === "`") {
        length++
        cursor++
      }
      const closing = source.indexOf("`".repeat(length), cursor)
      if (closing >= 0) cursor = closing + length
    }
  }
  if (source[cursor++] !== (definition ? ":" : "(")) return null
  while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++
  const angle = source[cursor] === "<"
  if (angle) cursor++
  const start = cursor
  let parentheses = 0
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === "\\") {
      cursor += 2
      continue
    }
    if (
      angle
        ? character === ">"
        : /\s/.test(character ?? "") || (character === ")" && parentheses === 0)
    )
      break
    if (!angle && character === "(") parentheses++
    if (!angle && character === ")") parentheses--
    cursor++
  }
  return cursor > start ? { start, end: cursor } : null
}
