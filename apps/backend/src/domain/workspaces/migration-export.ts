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

export function importKeyFromDedup(
  deduplicationKey: string | null,
): string | null {
  const key = deduplicationKey?.trim()
  return key ? key : null
}

export function importedObjectMarkdown(input: {
  title: string
  body: string
  importKey: string
  claims?: ReadonlyArray<{
    to: string
    predicate: string
    confidence?: number
    validFrom?: string | null
    validTo?: string | null
    source?: string | null
  }>
}): string {
  const lines = [`---`, `import_key: ${input.importKey}`]
  if (input.claims && input.claims.length > 0) {
    lines.push("claims:")
    for (const claim of input.claims) {
      lines.push(`  - to: ${claim.to}`)
      lines.push(`    predicate: ${claim.predicate}`)
      if (claim.confidence != null)
        lines.push(`    confidence: ${claim.confidence}`)
      if (claim.validFrom) lines.push(`    valid_from: ${claim.validFrom}`)
      if (claim.validTo) lines.push(`    valid_to: ${claim.validTo}`)
      if (claim.source) lines.push(`    source: ${claim.source}`)
    }
  }
  lines.push("---", "", `# ${input.title}`, "", input.body.trim(), "")
  return lines.join("\n")
}

export function noOpExportUsesResolvedTip(
  filesWouldChange: boolean,
  resolvedTip: string,
): { commit: false; exportSha: string } | { commit: true } {
  if (!filesWouldChange) return { commit: false, exportSha: resolvedTip }
  return { commit: true }
}
