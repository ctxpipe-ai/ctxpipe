import {
  type ProjectionState,
  publishedProjection,
  sameWorkspaceBinding,
  type WorkspaceRevision,
} from "./revision.js"

/** The revision that `desired_sha` holds, or null when there is none. */
export function desiredProjectionRevision(
  projection: ProjectionState,
): WorkspaceRevision | null {
  if (projection.kind === "active") return projection.revision
  if (projection.kind === "building" || projection.kind === "failed")
    return projection.desired
  return null
}

/**
 * The SHA that serves reads for this revision, or null when no published
 * projection has the same binding. A desired revision that differs from this
 * SHA needs a hydrate.
 */
export function servedSha(
  projection: ProjectionState,
  revision: WorkspaceRevision,
): string | null {
  const published = publishedProjection(projection)
  if (published?.kind === "legacy") return published.sha
  return published && sameWorkspaceBinding(published.revision, revision)
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
  if (!desiredProjectionRevision(projection)) return false
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
