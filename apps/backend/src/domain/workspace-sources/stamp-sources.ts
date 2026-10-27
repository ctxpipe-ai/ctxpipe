import { createHash } from "node:crypto"

import {
  asStringArray,
  splitFrontmatter,
} from "../codeIngestion/connectorFrontmatter.js"

/** Index range of the top-level `sources` key (key line plus its block). */
function sourcesRange(lines: string[]): [number, number] | null {
  const start = lines.findIndex((line) => line.startsWith("sources:"))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && /^(\s|- )/.test(lines[end] ?? "")) end++
  return [start, end]
}

function join(lines: string[], body: string): string {
  return lines.length
    ? `---\n${lines.join("\n")}\n---${body}`
    : `---\n---${body}`
}

function withoutRange(lines: string[], range: [number, number] | null) {
  return range ? [...lines.slice(0, range[0]), ...lines.slice(range[1])] : lines
}

/**
 * Set the host-owned `sources` list (ADR-050) as the last key of the front
 * matter of a mirror file. A file with no front matter stays as it is. The
 * result is the same for a file that already has the list.
 */
export function stampSources(text: string, paths: readonly string[]): string {
  const parts = splitFrontmatter(text)
  if (!parts) return text
  const lines = withoutRange(parts.lines, sourcesRange(parts.lines))
  return join(
    [...lines, "sources:", ...paths.map((path) => `  - ${path}`)],
    parts.body,
  )
}

/**
 * The `sources` list of a file (null when it has none) and the text without
 * it. The text without the list is what a converter wrote. Null when the
 * file has no front matter: the sync does not stamp it.
 */
export function readSourcesStamp(
  text: string,
): { sources: string[] | null; stripped: string } | null {
  const parts = splitFrontmatter(text)
  if (!parts) return null
  const range = sourcesRange(parts.lines)
  if (!range) return { sources: null, stripped: text }
  return {
    sources: asStringArray(parts.data.sources),
    stripped: join(withoutRange(parts.lines, range), parts.body),
  }
}

/**
 * The files of one mirror commit with the `sources` list `sourcePath`: each
 * file of the commit, plus each existing file with a wrong or missing list
 * (`restamped`, from Git) that the commit does not write again.
 */
export function stampMirrorFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
  sourcePath: string,
  existing: ReadonlyArray<{ path: string; restamped?: string }>,
): Array<{ path: string; content: string }> {
  const written = new Set(files.map((file) => file.path))
  return [
    ...files.map((file) => ({
      path: file.path,
      content: stampSources(file.content, [sourcePath]),
    })),
    ...existing.flatMap((blob) =>
      blob.restamped !== undefined && !written.has(blob.path)
        ? [{ path: blob.path, content: blob.restamped }]
        : [],
    ),
  ]
}

/** The Git blob id of UTF-8 text, as `git hash-object` prints it. */
export function gitBlobSha(text: string): string {
  const body = Buffer.from(text, "utf8")
  return createHash("sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex")
}
