import type { IngestionPublishPipeline } from "../ingestion/ingestion-v2-config.js"
import { ownershipMigrationFiles } from "../ingestion/ownership-migration.js"
import { githubSourcePathsByRepository } from "../workspace-sources/github-sources.js"
import type { SourceFileBlob } from "../workspace-sources/projection-plan.js"
import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { removeFolderMapMarkers } from "./folder-list.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import {
  claimsUpgradeRemainder,
  validFromPersistRemainder,
} from "./hydrate-write-jobs.js"
import type { WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export type HydrateWriteRequirement =
  | {
      kind:
        | "bootstrap"
        | "import_key_cleanup"
        | "ownership_migration"
        | "claims_upgrade"
        | "valid_from_persist"
      remainder: number
    }
  | {
      kind: "ops_folder_map"
      remainder: number
      /** Set when the folder set changed since this hydrated revision. */
      previousSha?: string
    }
  | { kind: "rename_rewrite"; remainder: number; previousSha: string }

/** Plan from committed files, before hydrate supplies derived valid_from values. */
export function planHydrateWrites(input: {
  revision: WorkspaceRevision
  displayName: string
  files: Array<{ path: string; content: string }>
  /** The blobs under `sources/`: they give the source path of each repository. */
  sourceFiles: ReadonlyArray<SourceFileBlob>
  publishPipeline: IngestionPublishPipeline
}): HydrateWriteRequirement[] {
  if (!githubRepoFullNameFromWorkspaceUrl(input.revision.remote.url)) return []
  const { units } = hydrateKnowledgeTree({
    workspaceId: input.revision.workspaceId,
    files: input.files,
  })
  const existing = new Map(input.files.map((file) => [file.path, file.content]))
  const agentsMd = existing.get("AGENTS.md") ?? ""
  const remaining = {
    bootstrap: bootstrapWorkspaceFiles({
      displayName: input.displayName,
      existing,
    }).filter((file) => existing.get(file.path) !== file.content).length,
    claims_upgrade: claimsUpgradeRemainder(units),
    valid_from_persist: validFromPersistRemainder(units),
    // Retired folder-map marker lines still in AGENTS.md: one cleanup write.
    ops_folder_map: removeFolderMapMarkers(agentsMd) === agentsMd ? 0 : 1,
    // Old extracted files move to ingestion v2 only while v2 publishes.
    ownership_migration:
      input.publishPipeline === "v2"
        ? ownershipMigrationFiles({
            workspaceRepositoryUrl: input.revision.remote.url,
            sourcePaths: githubSourcePathsByRepository(input.sourceFiles),
            files: input.files,
          }).length
        : 0,
  }
  // The `repositories/*.md` files of a Workspace that has no conversion yet
  // stay as they are: the conversion of CTX-721 T10 moves them.
  return (Object.keys(remaining) as Array<keyof typeof remaining>)
    .filter((kind) => remaining[kind] > 0)
    .map((kind) => ({ kind, remainder: remaining[kind] }))
}
