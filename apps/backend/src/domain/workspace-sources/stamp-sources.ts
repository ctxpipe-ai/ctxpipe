import { createHash } from "node:crypto"
import { parse as parseYaml } from "yaml"

const FRONT_MATTER = /^---\n([\s\S]*?)\n---(?=\n|$)/

/** Split the front matter lines from the text after them, or null. */
function split(
  text: string,
): { lines: string[]; after: string } | null {
  const match = FRONT_MATTER.exec(text)
  if (!match) return null
  return {
    lines: (match[1] ?? "").split("\n"),
    after: text.slice(match[0].length),
  }
}

/** Index range of the top-level `sources` key (key line plus its block). */
function sourcesRange(lines: string[]): [number, number] | null {
  const start = lines.findIndex((line) => line.startsWith("sources:"))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && /^(\s|- )/.test(lines[end] ?? "")) end++
  return [start, end]
}

function join(lines: string[], after: string): string {
  return `---\n${lines.join("\n")}\n---${after}`
}

/**
 * Set the host-owned `sources` list (ADR-050) as the last key of the front
 * matter of a mirror file. A file with no front matter stays as it is. The
 * result is the same for a file that already has the list.
 */
export function stampSources(text: string, paths: readonly string[]): string {
  const parts = split(text)
  if (!parts) return text
  const range = sourcesRange(parts.lines)
  const lines = range
    ? [...parts.lines.slice(0, range[0]), ...parts.lines.slice(range[1])]
    : parts.lines
  return join(
    [...lines, "sources:", ...paths.map((path) => `  - ${path}`)],
    parts.after,
  )
}

/**
 * The `sources` list of a file (null when it has none) and the text without
 * it. The text without the list is what a converter wrote.
 */
export function readSourcesStamp(text: string): {
  sources: string[] | null
  stripped: string
} {
  const parts = split(text)
  const range = parts ? sourcesRange(parts.lines) : null
  if (!parts || !range) return { sources: null, stripped: text }
  let sources: string[] | null = null
  try {
    const value = parseYaml(parts.lines.slice(...range).join("\n")) as {
      sources?: unknown
    }
    if (
      Array.isArray(value?.sources) &&
      value.sources.every((item) => typeof item === "string")
    )
      sources = value.sources
  } catch {
    sources = null
  }
  return {
    sources,
    stripped: join(
      [...parts.lines.slice(0, range[0]), ...parts.lines.slice(range[1])],
      parts.after,
    ),
  }
}

/** The Git blob id of UTF-8 text, as `git hash-object` prints it. */
export function gitBlobSha(text: string): string {
  const body = Buffer.from(text, "utf8")
  return createHash("sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex")
}
