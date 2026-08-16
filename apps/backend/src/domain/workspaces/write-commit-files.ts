import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import {
  migrationExportFiles,
  type planMigrationExport,
} from "./migration-export.js"

export function filesForWorkspaceWriteKind(input: {
  kind: "migration_export" | "link_unlink" | "bootstrap"
  displayName: string
  linkedUrls: Iterable<string>
  existing: ReadonlyMap<string, string>
  exportPlan?: ReturnType<typeof planMigrationExport>
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
    linkedUrls: input.linkedUrls,
  })
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
