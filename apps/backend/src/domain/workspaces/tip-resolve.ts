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
  projection: ProjectionState
  /**
   * The UTC hour of the check and the first failure time of each failed
   * phase. With it, a failed graph or index is built again only when
   * `failedPhaseRetryDue` says so.
   */
  retry?: { hour: string; failedAt: { graph?: string; index?: string } }
}): boolean {
  const projection = input.projection
  if (!desiredProjectionRevision(projection)) return false
  if (projection.kind !== "active") return true
  if (projection.stores.embeddings.kind !== "ready") return true
  const retry = input.retry
  return (["graph", "index"] as const).some((phase) => {
    const kind = projection.stores[phase].kind
    if (kind !== "failed") return kind !== "ready"
    return !retry || failedPhaseRetryDue(retry.failedAt[phase], retry.hour)
  })
}

/**
 * A failed phase is built again in the check of the UTC hour that is 1, 2,
 * 4, 8 or 16 hours after the hour of its first failure, then each 24 hours.
 * A phase with no stored failure time is built again in each check.
 */
export function failedPhaseRetryDue(
  failedAt: string | undefined,
  hour: string,
): boolean {
  if (!failedAt) return true
  const hours =
    Math.floor(Date.parse(`${hour}:00:00.000Z`) / 3_600_000) -
    Math.floor(Date.parse(failedAt) / 3_600_000)
  if (hours <= 16) return [1, 2, 4, 8, 16].includes(hours)
  return (hours - 16) % 24 === 0
}
