import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { removeFolderMapMarkers } from "./folder-list.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import {
  claimsUpgradeRemainder,
  validFromPersistRemainder,
} from "./hydrate-write-jobs.js"
import { parseLinkedRepositoryMarkdown } from "./layout.js"
import { upgradeLinkedRepositories } from "./migration-export.js"
import type { WorkspaceRevision } from "./revision.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export type HydrateWriteRequirement =
  | {
      kind:
        | "bootstrap"
        | "import_key_cleanup"
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
  /** Moves the GitHub `repositories/*.md` files into the sources file. */
  | { kind: "link_unlink"; remainder: number; linkGitUrl: string }

/** Plan from committed files, before hydrate supplies derived valid_from values. */
export function planHydrateWrites(input: {
  revision: WorkspaceRevision
  displayName: string
  files: Array<{ path: string; content: string }>
  /** The text of `.ctxpipe/sources.yaml`, or null. */
  sourcesFile?: string | null
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
  }
  const planned: HydrateWriteRequirement[] = (
    Object.keys(remaining) as Array<keyof typeof remaining>
  )
    .filter((kind) => remaining[kind] > 0)
    .map((kind) => ({ kind, remainder: remaining[kind] }))
  // ADR-050: a Workspace that the export did not convert (for example, one
  // exported before the upgrade) still has `repositories/*.md` files that
  // link nothing. One link edit of the first file moves them all.
  const connectionId = input.revision.remote.connectionId
  if (connectionId) {
    const { deletePaths } = upgradeLinkedRepositories({
      sourcesFile: input.sourcesFile ?? null,
      connectionId,
      files: input.files,
    })
    const first = existing.get(deletePaths[0] ?? "")
    const parsed = first ? parseLinkedRepositoryMarkdown(first) : null
    if (parsed && !parsed.malformed)
      planned.push({
        kind: "link_unlink",
        remainder: deletePaths.length,
        linkGitUrl: normalizeWorkspaceRepositoryUrl(parsed.git),
      })
  }
  return planned
}
