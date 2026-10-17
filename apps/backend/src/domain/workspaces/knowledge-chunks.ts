import { createHash } from "node:crypto"

/**
 * Chunk rule (ADR-051): one chunk per Markdown heading section. A section over
 * the cap packs its paragraphs (blank-line runs) into chunks up to the cap, and
 * a paragraph over the cap splits on length.
 *
 * Why: authors edit one section at a time, so an edit changes the hash of its
 * own chunks only, and hydrate embeds only those again. Sections do not merge,
 * because a merge would make a chunk depend on its neighbors. In a section
 * over the cap, an edit can move the later chunk boundaries of that section.
 * The cap (512 tokens at about 4 characters each, no tokenizer) keeps each
 * chunk a precise search hit and well inside the input limit of the model.
 */
const CHUNK_CHARACTER_CAP = 512 * 4

type Fence = { char: string; length: number }

/** Each line of a Markdown body, with its ATX heading text and level when it is one. */
export function markdownLines(
  body: string,
): Array<{ line: string; heading: string | null; level: number }> {
  let fence: Fence | null = null
  return body.split("\n").map((line) => {
    const plain = { line, heading: null, level: 0 }
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1]
      if (close && close[0] === fence.char && close.length >= fence.length)
        fence = null
      return plain
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open?.[1] && !(open[1][0] === "`" && open[2]?.includes("`"))) {
      fence = { char: open[1][0] ?? "`", length: open[1].length }
      return plain
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    const text = heading?.[2]?.trim()
    return text && heading?.[1]
      ? { line, heading: text, level: heading[1].length }
      : plain
  })
}

export type KnowledgeChunk = {
  /** Headings that contain the chunk, outermost first. */
  headingPath: string[]
  text: string
  /** 1-based lines of the body, inclusive. */
  startLine: number
  endLine: number
}

export function chunkKnowledgeBody(body: string): KnowledgeChunk[] {
  const lines = markdownLines(body)
  const sections: Array<{ headingPath: string[]; start: number; end: number }> =
    []
  const path: Array<{ level: number; text: string }> = []
  lines.forEach(({ heading, level }, index) => {
    if (heading !== null) {
      while ((path.at(-1)?.level ?? 0) >= level) path.pop()
      path.push({ level, text: heading })
    }
    if (heading !== null || sections.length === 0)
      sections.push({
        headingPath: path.map((entry) => entry.text),
        start: index,
        end: index + 1,
      })
    else {
      const last = sections.at(-1)
      if (last) last.end = index + 1
    }
  })
  const blank = (index: number) => !lines[index]?.line.trim()
  return sections.flatMap(({ headingPath, start, end }) => {
    while (start < end && blank(start)) start += 1
    while (end > start && blank(end - 1)) end -= 1
    if (start === end) return []
    const piece = (from: number, to: number): KnowledgeChunk => ({
      headingPath,
      text: lines
        .slice(from, to)
        .map((entry) => entry.line)
        .join("\n"),
      startLine: from + 1,
      endLine: to,
    })
    const whole = piece(start, end)
    if (whole.text.length <= CHUNK_CHARACTER_CAP) return [whole]
    const chunks: KnowledgeChunk[] = []
    let index = start
    while (index < end) {
      if (blank(index)) {
        index += 1
        continue
      }
      let stop = index
      while (stop < end && !blank(stop)) stop += 1
      const paragraph = piece(index, stop)
      const last = chunks.at(-1)
      if (
        last &&
        last.text.length + 2 + paragraph.text.length <= CHUNK_CHARACTER_CAP
      )
        chunks[chunks.length - 1] = {
          ...last,
          text: `${last.text}\n\n${paragraph.text}`,
          endLine: paragraph.endLine,
        }
      else chunks.push(...splitByLength(paragraph))
      index = stop
    }
    return chunks
  })
}

/** Split on code points, so that a split never cuts a surrogate pair. */
function splitByLength(chunk: KnowledgeChunk): KnowledgeChunk[] {
  const points = Array.from(chunk.text)
  if (points.length <= CHUNK_CHARACTER_CAP) return [chunk]
  const out: KnowledgeChunk[] = []
  let line = chunk.startLine
  for (let at = 0; at < points.length; at += CHUNK_CHARACTER_CAP) {
    const text = points.slice(at, at + CHUNK_CHARACTER_CAP).join("")
    const newlines = text.split("\n").length - 1
    out.push({ ...chunk, text, startLine: line, endLine: line + newlines })
    line += newlines
  }
  return out
}

export type KnowledgeChunkRow = {
  unitId: string
  /** SHA-256 of the embedding model id and `text`. */
  chunkHash: string
  /** Index among the chunks of the unit with the same hash. */
  occurrence: number
  ordinal: number
  /** The indexed and embedded text: title and heading path, then the section. */
  text: string
  /** 1-based lines of the file, inclusive. */
  startLine: number
  endLine: number
}

/** The chunk rows of a projection's units, in unit order. */
export function knowledgeChunkRows(
  units: ReadonlyArray<{
    servingId: string
    body: string
    title: string | null
    /** The file line of the first body line (after front matter). */
    bodyStartLine?: number
  }>,
  embeddingModel: string,
): KnowledgeChunkRow[] {
  return units.flatMap((unit) => {
    const seen = new Map<string, number>()
    const offset = (unit.bodyStartLine ?? 1) - 1
    return chunkKnowledgeBody(unit.body).map((chunk, ordinal) => {
      const context = [unit.title, ...chunk.headingPath].filter(
        (part, index, parts): part is string =>
          Boolean(part) && part !== parts[index - 1],
      )
      const text = context.length
        ? `${context.join(" > ")}\n\n${chunk.text}`
        : chunk.text
      const chunkHash = createHash("sha256")
        .update(`${embeddingModel}\0${text}`)
        .digest("hex")
      const occurrence = seen.get(chunkHash) ?? 0
      seen.set(chunkHash, occurrence + 1)
      return {
        unitId: unit.servingId,
        chunkHash,
        occurrence,
        ordinal,
        text,
        startLine: chunk.startLine + offset,
        endLine: chunk.endLine + offset,
      }
    })
  })
}
