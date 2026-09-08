import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import {
  claimsUpgradeRemainder,
  opsFolderMapRemainder,
  validFromPersistRemainder,
} from "./hydrate-write-jobs.js"
import type { WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** Plan from committed files, before hydrate supplies derived valid_from values. */
export function planHydrateWrites(input: {
  revision: WorkspaceRevision
  displayName: string
  files: Array<{ path: string; content: string }>
}) {
  if (!githubRepoFullNameFromWorkspaceUrl(input.revision.remote.url)) return []
  const { units } = hydrateKnowledgeTree({
    workspaceId: input.revision.workspaceId,
    files: input.files,
  })
  const existing = new Map(input.files.map((file) => [file.path, file.content]))
  const remaining = {
    bootstrap: bootstrapWorkspaceFiles({
      displayName: input.displayName,
      existing,
    }).filter((file) => existing.get(file.path) !== file.content).length,
    claims_upgrade: claimsUpgradeRemainder(units),
    valid_from_persist: validFromPersistRemainder(units),
    ops_folder_map: opsFolderMapRemainder(existing.get("AGENTS.md") ?? null),
  }
  return (Object.keys(remaining) as Array<keyof typeof remaining>)
    .filter((kind) => remaining[kind] > 0)
    .map((kind) => ({ kind, remainder: remaining[kind] }))
}
