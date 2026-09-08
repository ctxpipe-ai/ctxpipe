import { FOLDER_MAP_END, FOLDER_MAP_START } from "./bootstrap.js"
import { parseSimpleFrontMatter } from "./layout.js"

function directoryReference(value: string): string | null {
  if (!value.endsWith("/")) return null
  try {
    const path = decodeURIComponent(value).replace(/^\.\//, "")
    if (!path || path.startsWith("/") || /[:#?]/.test(path)) return null
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

/** Maintain only the folder section; preserve the owner's metadata and other sections. */
export function maintainFolderMap(input: {
  displayName: string
  existing: string | null
  paths: readonly string[]
}): string {
  const original =
    input.existing ??
    `---\nname: ${JSON.stringify(input.displayName.trim() || "Workspace")}\n---\n\n`
  if (parseSimpleFrontMatter(original).malformed) return original
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
  // Incomplete markers are user content, not a safe region to rewrite.
  if (
    !marked &&
    lines.some((line) =>
      [FOLDER_MAP_START, FOLDER_MAP_END].includes(line.trim()),
    )
  )
    return original
  if (!marked) {
    start = lines.findIndex((line) =>
      /^#{1,6}\s+.*\b(folders?|director(?:y|ies)|layout|structure)\b/i.test(
        line,
      ),
    )
    if (start < 0) {
      const reference = lines.findIndex(
        (line) => folderReferences(line).length > 0,
      )
      if (reference >= 0)
        for (let index = reference; index >= 0; index--)
          if (/^#{1,6}\s/.test(lines[index] ?? "")) {
            start = index
            break
          }
    }
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
      `- [${path.replace(/[[\]\\]/g, "\\$&")}](${encodeURIComponent(path.slice(0, -1))}/)`,
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
