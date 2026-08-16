import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import {
  migrationExportFiles,
  type planMigrationExport,
} from "./migration-export.js"

export type WorkspaceLinkChange = {
  action: "link" | "unlink"
  gitUrl: string
}

function linkedRepositoryFileName(url: string): string | null {
  const name = url
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
    .pop()
  return name || null
}

export function linkedUrlsAfterWrite(input: {
  currentUrls: Iterable<string>
  linkChange?: WorkspaceLinkChange
}): string[] {
  const urls = [...input.currentUrls]
  if (!input.linkChange) return urls
  const target = linkedRepositoryFileName(input.linkChange.gitUrl)
  if (input.linkChange.action === "unlink") {
    return urls.filter((url) => linkedRepositoryFileName(url) !== target)
  }
  if (
    urls.some((url) => linkedRepositoryFileName(url) === target) ||
    !input.linkChange.gitUrl.trim()
  ) {
    return urls
  }
  return [...urls, input.linkChange.gitUrl]
}

export function filesForWorkspaceWriteKind(input: {
  kind: "migration_export" | "link_unlink" | "bootstrap"
  displayName: string
  linkedUrls: Iterable<string>
  existing: ReadonlyMap<string, string>
  exportPlan?: ReturnType<typeof planMigrationExport>
  linkChange?: WorkspaceLinkChange
}): Array<{ path: string; content: string }> {
  if (input.kind === "bootstrap") {
    return bootstrapWorkspaceFiles({
      displayName: input.displayName,
      existing: input.existing,
    })
  }
  if (input.kind === "migration_export" && input.exportPlan) {
    return input.exportPlan.files
  }
  return migrationExportFiles({
    imported: [],
    takenPaths: [],
    linkedUrls: linkedUrlsAfterWrite({
      currentUrls: input.linkedUrls,
      linkChange: input.linkChange,
    }),
  })
}

export function deletePathsForWorkspaceWriteKind(input: {
  kind: "migration_export" | "link_unlink" | "bootstrap"
  linkedUrls: Iterable<string>
  linkChange?: WorkspaceLinkChange
}): string[] {
  void input.linkedUrls
  if (input.kind !== "link_unlink" || input.linkChange?.action !== "unlink") {
    return []
  }
  const name = linkedRepositoryFileName(input.linkChange.gitUrl)
  return name ? [`repositories/${name}.md`] : []
}

export function shouldEnqueueBootstrapAfterExport(input: {
  kind: "migration_export" | "link_unlink" | "bootstrap"
  committed: boolean
  noOpExport: boolean
}): boolean {
  return (
    input.kind === "migration_export" && (input.committed || input.noOpExport)
  )
}
