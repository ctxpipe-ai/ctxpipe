import { nextImportedKnowledgePath } from "./migration-cutover.js"

export const MIGRATION_EXPORT_KIND = "migration_export"

export function migrationExportFiles(input: {
  imported: ReadonlyArray<{ slug: string; body: string }>
  takenPaths: Iterable<string>
  linkedUrls: Iterable<string>
}): Array<{ path: string; content: string }> {
  const taken = new Set(input.takenPaths)
  const files: Array<{ path: string; content: string }> = []
  for (const item of input.imported) {
    const path = nextImportedKnowledgePath(item.slug, taken)
    taken.add(path)
    files.push({ path, content: item.body })
  }
  for (const url of input.linkedUrls) {
    const name = url
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean)
      .pop()
    if (!name) continue
    const path = `repositories/${name}.md`
    if (taken.has(path)) continue
    taken.add(path)
    files.push({
      path,
      content: `---\ngit: ${url}\n---\n`,
    })
  }
  return files
}

export function noOpExportUsesResolvedTip(
  filesWouldChange: boolean,
  resolvedTip: string,
): { commit: false; exportSha: string } | { commit: true } {
  if (!filesWouldChange) return { commit: false, exportSha: resolvedTip }
  return { commit: true }
}
