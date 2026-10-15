import {
  type ProjectionState,
  publishedProjection,
  sameWorkspaceBinding,
  type WorkspaceRevision,
} from "./revision.js"

/**
 * The SHA that serves reads for this tip, or null when no published
 * projection has the same binding. A tip that differs from this SHA needs a
 * hydrate, also when `desired_sha` already holds the tip.
 */
export function servedShaForTip(
  projection: ProjectionState,
  tip: WorkspaceRevision,
): string | null {
  const published = publishedProjection(projection)
  if (published?.kind === "legacy") return published.sha
  return published && sameWorkspaceBinding(published.revision, tip)
    ? published.revision.sha
    : null
}

export function isDefaultBranchPush(
  ref: string,
  defaultBranch: string,
): boolean {
  return ref === `refs/heads/${defaultBranch}`
}

export function shouldEnqueueCronHydrate(input: {
  migrationExportSha: string | null | undefined
  projection: ProjectionState
  writeStatus?: string | null
}): boolean {
  const projection = input.projection
  const desired =
    projection.kind === "active"
      ? projection.revision
      : projection.kind === "building" || projection.kind === "failed"
        ? projection.desired
        : null
  if (!desired) return false
  const skipExportWait =
    input.writeStatus === "read_only" || input.writeStatus === "unknown"
  if (!skipExportWait && !input.migrationExportSha) return false
  return (
    projection.kind !== "active" ||
    projection.stores.graph.kind !== "ready" ||
    projection.stores.embeddings.kind !== "ready" ||
    projection.stores.index.kind !== "ready"
  )
}
