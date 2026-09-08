import type { ProjectionState } from "./revision.js"

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
    projection.stores.embeddings.kind !== "ready" ||
    projection.stores.index.kind !== "ready"
  )
}
