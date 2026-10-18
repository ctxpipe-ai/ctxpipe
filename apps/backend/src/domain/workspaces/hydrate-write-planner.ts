import { ownershipMigrationFiles } from "../ingestion/ownership-migration.js"
import { repositorySourcePathsAtRevision } from "../workspace-sources/github-sources.js"
import type {
  PreviousSourceRow,
  SourceFileBlob,
} from "../workspace-sources/projection-plan.js"
import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { removeFolderMapMarkers } from "./folder-list.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import {
  claimsUpgradeRemainder,
  importKeyCleanupRemainder,
  validFromPersistRemainder,
} from "./hydrate-write-jobs.js"
import type { WorkspaceRevision } from "./revision.js"
import {
  INGESTION_V2_PUBLISH_FORMAT,
  workspaceFormatAtLeast,
} from "./workspace-format.js"
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

/** The changes between the last hydrated revision and this one. */
export type HydrateWriteHistory = {
  previousSha: string
  /** The format in the tree of `previousSha`. */
  previousFormat: number
  /** Files whose links a rename made stale. */
  renameRewrites: number
  /** True when the set of listed folders changed. */
  folderSetChanged: boolean
}

/**
 * Plan the direct writes of hydrate from committed files, before hydrate
 * supplies derived valid_from values. Each planned job commits to the
 * default branch with no pull request.
 *
 * Below format 3 hydrate plans no write (ADR-053 section 7): the upgrade
 * pull request makes each layout change, also the bootstrap files and the
 * claim and valid_from rewrites. At format 3 or more these are ctx|-managed
 * files of a v2 Workspace, so hydrate keeps them current.
 */
export async function planHydrateWrites(input: {
  revision: WorkspaceRevision
  displayName: string
  files: Array<{ path: string; content: string }>
  /** The blobs under `sources/`: the source path of each repository. */
  sourceFiles: ReadonlyArray<SourceFileBlob>
  /** The stored source rows: they decide the winner of a repository. */
  sourceRows: ReadonlyArray<PreviousSourceRow>
  /** The format in the tree of `revision` (0 for no file, -1 for an invalid one). */
  format: number
  /** Read only when hydrate can write; null when no earlier revision differs. */
  history?: () => Promise<HydrateWriteHistory | null>
}): Promise<HydrateWriteRequirement[]> {
  if (!githubRepoFullNameFromWorkspaceUrl(input.revision.remote.url)) return []
  const writable = (format: number) =>
    workspaceFormatAtLeast(format, INGESTION_V2_PUBLISH_FORMAT)
  if (!writable(input.format)) return []
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
    import_key_cleanup: importKeyCleanupRemainder(input.files),
    // Retired folder-map marker lines still in AGENTS.md: one cleanup write.
    ops_folder_map: removeFolderMapMarkers(agentsMd) === agentsMd ? 0 : 1,
    ownership_migration: ownershipMigrationFiles({
      workspaceRepositoryUrl: input.revision.remote.url,
      sourcePaths: repositorySourcePathsAtRevision(
        input.sourceFiles,
        input.sourceRows,
      ),
      files: input.files,
    }).length,
  }
  const plan: HydrateWriteRequirement[] = (
    Object.keys(remaining) as Array<keyof typeof remaining>
  )
    .filter((kind) => remaining[kind] > 0)
    .map((kind) => ({ kind, remainder: remaining[kind] }))
  const history = await input.history?.()
  // From a tree below format 3, the change is the upgrade pull request. Its
  // moves are layout changes, not renames of a person, and its last step
  // wrote AGENTS.md. Hydrate has no write to add.
  if (!history || !writable(history.previousFormat)) return plan
  if (history.renameRewrites > 0)
    plan.push({
      kind: "rename_rewrite",
      previousSha: history.previousSha,
      remainder: history.renameRewrites,
    })
  if (history.folderSetChanged) {
    // One job both removes old markers and updates the list.
    const planned = plan.find(
      (requirement) => requirement.kind === "ops_folder_map",
    )
    if (planned?.kind === "ops_folder_map") {
      planned.previousSha = history.previousSha
      planned.remainder += 1
    } else
      plan.push({
        kind: "ops_folder_map",
        previousSha: history.previousSha,
        remainder: 1,
      })
  }
  return plan
}
