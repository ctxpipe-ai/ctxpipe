import { createHash } from "node:crypto"

/**
 * Chunk rule (ADR-051): one chunk per Markdown heading section, and a section
 * over the cap splits on blank lines, then on length.
 *
 * Why: authors edit one section at a time, so an edit changes the hash of its
 * own chunk only, and hydrate embeds only that chunk again. Sections do not
 * merge, because a merge would make a chunk depend on its neighbors. The cap
 * (512 tokens at about 4 characters each, no tokenizer) keeps each chunk a
 * precise search hit and well inside the input limit of the embedding model.
 */
const CHUNK_CHARACTER_CAP = 512 * 4

/** Each line of a Markdown body, with its ATX heading text when it is one. */
export function markdownLines(
  body: string,
): Array<{ line: string; heading: string | null }> {
  let fence: string | null = null
  return body.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      return { line, heading: null }
    }
    if (fence !== null) return { line, heading: null }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    return { line, heading: heading?.[1]?.trim() || null }
  })
}

export function chunkKnowledgeBody(body: string): string[] {
  const sections: string[][] = [[]]
  for (const { line, heading } of markdownLines(body)) {
    if (heading !== null) sections.push([])
    sections.at(-1)?.push(line)
  }
  return sections.flatMap((lines) => {
    const section = lines.join("\n").trim()
    if (!section) return []
    if (section.length <= CHUNK_CHARACTER_CAP) return [section]
    const pieces: string[] = []
    for (const paragraph of section.split(/\n[ \t]*\n/)) {
      const text = paragraph.trim()
      if (!text) continue
      const last = pieces.at(-1)
      if (
        last !== undefined &&
        last.length + 2 + text.length <= CHUNK_CHARACTER_CAP
      )
        pieces[pieces.length - 1] = `${last}\n\n${text}`
      else
        for (let at = 0; at < text.length; at += CHUNK_CHARACTER_CAP)
          pieces.push(text.slice(at, at + CHUNK_CHARACTER_CAP))
    }
    return pieces
  })
}

/** The chunk rows of a projection's units, in unit order. */
export function knowledgeChunkRows(
  units: ReadonlyArray<{ servingId: string; body: string }>,
): Array<{ unitId: string; ordinal: number; text: string; chunkHash: string }> {
  return units.flatMap((unit) =>
    chunkKnowledgeBody(unit.body).map((text, ordinal) => ({
      unitId: unit.servingId,
      ordinal,
      text,
      chunkHash: createHash("sha256").update(text).digest("hex"),
    })),
  )
}
