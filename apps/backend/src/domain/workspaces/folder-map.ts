import { FOLDER_MAP_END, FOLDER_MAP_START } from "./bootstrap.js"
import { updateKnowledgeMetadata } from "./knowledge-metadata.js"
import { parseSimpleFrontMatter } from "./layout.js"

function directoryReference(value: string): string | null {
  if (!value.endsWith("/") || /[:#?]/.test(value)) return null
  try {
    const path = decodeURIComponent(value).replace(/^\.\//, "")
    if (!path || path.startsWith("/")) return null
    if (path.split("/").some((part) => part === ".." || part === "."))
      return null
    return path
  } catch {
    return null
  }
}

function folderReferences(line: string): string[] {
  return [...line.matchAll(/\[[^\]]+\]\(([^)\s]+)\)|`([^`]+\/)`/g)]
    .map((match) => directoryReference(match[1] ?? match[2] ?? ""))
    .filter((path): path is string => path !== null)
}

export function folderMapMarkerState(
  markdown: string,
): "absent" | "valid" | "invalid" {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim())
  const starts = lines.flatMap((line, index) =>
    line === FOLDER_MAP_START ? [index] : [],
  )
  const ends = lines.flatMap((line, index) =>
    line === FOLDER_MAP_END ? [index] : [],
  )
  if (!starts.length && !ends.length) return "absent"
  const start = starts[0]
  const end = ends[0]
  return starts.length === 1 &&
    ends.length === 1 &&
    start !== undefined &&
    end !== undefined &&
    start < end
    ? "valid"
    : "invalid"
}

/** Maintain only the folder section; preserve the owner's metadata and other sections. */
export function maintainFolderMap(input: {
  displayName: string
  requestedDisplayName?: string
  existing: string | null
  paths: readonly string[]
}): string {
  let original =
    input.existing ??
    `---\nname: ${JSON.stringify(input.displayName.trim() || "Workspace")}\n---\n\n`
  if (parseSimpleFrontMatter(original).malformed) return original
  if (input.requestedDisplayName !== undefined)
    original = updateKnowledgeMetadata(original, (document) =>
      document.set("name", input.requestedDisplayName),
    )
  const newline = original.includes("\r\n") ? "\r\n" : "\n"
  const prefix =
    original.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? ""
  const lines = original.slice(prefix.length).split(newline)
  const directories = new Set<string>()
  for (const path of input.paths) {
    const parts = path.split("/")
    for (let depth = 1; depth < parts.length; depth++)
      directories.add(`${parts.slice(0, depth).join("/")}/`)
  }
  let start = lines.findIndex((line) => line.trim() === FOLDER_MAP_START)
  let end = lines.findIndex(
    (line, index) => index > start && line.trim() === FOLDER_MAP_END,
  )
  const marked = start >= 0 && end > start
  if (folderMapMarkerState(original) === "invalid")
    throw new Error("Folder-map markers are ambiguous or incomplete")
  if (!marked) {
    // A heading keyword is insufficient: the section must actually contain a
    // folder list. Consider its direct body, never a descendant heading's list.
    const candidates = lines.flatMap((line, index) => {
      if (!/^#{1,6}\s/.test(line)) return []
      let limit = lines.findIndex(
        (next, nextIndex) => nextIndex > index && /^#{1,6}\s/.test(next),
      )
      if (limit < 0) limit = lines.length
      const hasFolderList = lines
        .slice(index + 1, limit)
        .some(
          (entry) =>
            /^\s*[-*+]\s+(?:\[[^\]]+\]\([^)]*\)|`[^`]+`)/.test(entry) &&
            folderReferences(entry).length > 0,
        )
      return hasFolderList ? [index] : []
    })
    start =
      candidates.find((index) =>
        /\b(folders?|director(?:y|ies)|layout|structure)\b/i.test(
          lines[index] ?? "",
        ),
      ) ??
      candidates[0] ??
      -1
    const depth = start >= 0 ? (lines[start]?.match(/^#+/)?.[0].length ?? 6) : 0
    end =
      start >= 0
        ? lines.findIndex(
            (line, index) =>
              index > start &&
              (line.match(/^#{1,6}(?=\s)/)?.[0].length ?? 7) <= depth,
          )
        : -1
    if (end < 0) end = lines.length
  }
  const section =
    start >= 0
      ? lines.slice(start + (marked ? 1 : 0), end)
      : ["## Folder Structure", ""]
  const retained: string[] = []
  for (const line of section) {
    const references = folderReferences(line)
    if (
      /^\s*[-*+]\s/.test(line) &&
      references.length &&
      references.every((path) => !directories.has(path))
    )
      continue
    retained.push(
      line.replace(
        /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+\/)`/g,
        (
          match,
          label: string | undefined,
          href: string | undefined,
          code: string | undefined,
        ) => {
          const path = directoryReference(href ?? code ?? "")
          return path && !directories.has(path)
            ? (label ?? code?.slice(0, -1) ?? match)
            : match
        },
      ),
    )
  }
  const referenced = new Set(retained.flatMap(folderReferences))
  const missing = [...directories]
    .filter(
      (path) =>
        path.split("/").length === 2 &&
        !path.startsWith(".") &&
        !referenced.has(path),
    )
    .sort()
  while (retained.at(-1) === "") retained.pop()
  for (const path of missing)
    retained.push(
      `- [${path.replace(/[[\]\\]/g, "\\$&")}](${encodeURIComponent(path.slice(0, -1)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}/)`,
    )
  const replacement = [FOLDER_MAP_START, ...retained, FOLDER_MAP_END]
  if (start < 0) {
    while (lines.at(-1) === "") lines.pop()
    return `${prefix}${[...lines, "", ...replacement, ""].join(newline)}`
  }
  lines.splice(
    start,
    end - start + (marked ? 1 : 0),
    ...replacement,
    ...(marked ? [] : [""]),
  )
  return prefix + lines.join(newline)
}
