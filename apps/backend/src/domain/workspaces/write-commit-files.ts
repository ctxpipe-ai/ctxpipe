import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import {
  claimsUpgradeFiles,
  opsFolderMapFiles,
  validFromPersistFiles,
} from "./hydrate-write-jobs.js"
import {
  migrationExportFiles,
  type planMigrationExport,
} from "./migration-export.js"
import type { WorkspaceWriteJobKind } from "./write-jobs.js"

export type WorkspaceWriteKind = WorkspaceWriteJobKind | "migration_export"

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
  kind: WorkspaceWriteKind
  displayName: string
  linkedUrls: Iterable<string>
  existing: ReadonlyMap<string, string>
  exportPlan?: ReturnType<typeof planMigrationExport>
  linkChange?: WorkspaceLinkChange
  workspaceId?: string
  introducingSha?: string
}): Array<{ path: string; content: string }> {
  if (input.kind === "bootstrap") {
    return bootstrapWorkspaceFiles({
      displayName: input.displayName,
      existing: input.existing,
    })
  }
  if (input.kind === "ops_folder_map") {
    return opsFolderMapFiles({
      displayName: input.displayName,
      existingAgentsMd: input.existing.get("AGENTS.md") ?? null,
    })
  }
  if (
    (input.kind === "claims_upgrade" || input.kind === "valid_from_persist") &&
    input.workspaceId
  ) {
    const files = [...input.existing].map(([path, content]) => ({
      path,
      content,
    }))
    const parsed = hydrateKnowledgeTree({
      workspaceId: input.workspaceId,
      files,
    })
    if (input.kind === "claims_upgrade") {
      return claimsUpgradeFiles({ files, units: parsed.units })
    }
    return validFromPersistFiles({
      files,
      units: parsed.units,
      introducingSha: input.introducingSha ?? "",
    })
  }
  if (input.kind === "migration_export" && input.exportPlan) {
    return input.exportPlan.files
  }
  if (input.kind === "link_unlink" || input.kind === "migration_export") {
    return migrationExportFiles({
      imported: [],
      takenPaths: [],
      linkedUrls: linkedUrlsAfterWrite({
        currentUrls: input.linkedUrls,
        linkChange: input.linkChange,
      }),
    })
  }
  return []
}

export function deletePathsForWorkspaceWriteKind(input: {
  kind: WorkspaceWriteKind
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
  kind: WorkspaceWriteKind
  committed: boolean
  noOpExport: boolean
}): boolean {
  return (
    input.kind === "migration_export" && (input.committed || input.noOpExport)
  )
}
