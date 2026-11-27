import { createHash } from "node:crypto"

import type { HydrateUnit } from "./hydrate.js"
import {
  type PublishedProjection,
  sameWorkspaceBinding,
  type WorkspaceRevision,
} from "./revision.js"

/**
 * The reasons for a full hydrate write instead of a partial one.
 *
 * - `no_base`: no active projection to start from.
 * - `reproject`: the run must project the revision again (a re-ingestion).
 * - `lineage`: the active projection has another generation, remote,
 *   connection or default branch.
 * - `format_changed`: the Workspace format of the new tree is not the cached
 *   format of the active projection.
 * - `base_moved`: another hydrate changed the active projection after this
 *   run selected its base.
 * - `unit_bound`: too many units changed (`partialUnitBound`).
 *
 * `hydrateCommitBase` selects the first four reasons, which need no lock.
 * The commit adds `base_moved` under the row lock, and `unit_bound` after
 * it compares the units with the stored rows.
 *
 * A base SHA that is not an ancestor of the new SHA, and a change of the
 * folder set, need no full write. The partial write compares the complete
 * new unit set with the stored rows (`diffHydrateUnits`), so its result does
 * not depend on how the two SHAs relate in Git.
 */
export type HydrateFullReason =
  | "no_base"
  | "reproject"
  | "lineage"
  | "format_changed"
  | "base_moved"
  | "unit_bound"

/**
 * The base of a hydrate commit: the active projection that a partial write
 * diffs against, or the reason for a full write.
 */
export type HydrateCommitBase =
  | { revision: WorkspaceRevision }
  | { fullReason: HydrateFullReason }

/** Select the base of a hydrate commit from the values that need no lock. */
export function hydrateCommitBase(input: {
  /** The revision that the hydrate commits. */
  revision: WorkspaceRevision
  projection: PublishedProjection | null
  reproject: boolean
  formatChanged: boolean
}): HydrateCommitBase {
  const { projection } = input
  if (input.reproject) return { fullReason: "reproject" }
  if (projection?.kind !== "active") return { fullReason: "no_base" }
  if (!sameWorkspaceBinding(projection.revision, input.revision))
    return { fullReason: "lineage" }
  if (input.formatChanged) return { fullReason: "format_changed" }
  return { revision: projection.revision }
}

/**
 * The maximum number of changed and removed units for a partial write: 10%
 * of the stored units. A partial write uses one upsert for each 500 changed
 * rows and one delete for each 1,000 removed rows, and a full write deletes
 * all rows and inserts each 500 rows. Above about 10% of the units, the
 * partial statements cost about as much as the full rewrite.
 */
export function partialUnitBound(storedUnits: number): number {
  return Math.ceil(storedUnits * 0.1)
}

/**
 * A hash of each value that hydrate stores for a unit: the row columns and
 * the first body line.
 */
export function hydrateUnitHash(unit: HydrateUnit): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        // The hash version. Increase it when the hashed values change.
        2,
        unit.servingId,
        unit.path,
        unit.kind ?? null,
        unit.title ?? null,
        unit.source ?? null,
        unit.body,
        unit.links,
        unit.claims.map((claim) => [
          claim.to,
          claim.predicate,
          claim.confidence,
          claim.validFrom,
          claim.validTo,
          claim.source,
        ]),
        unit.updatedAt,
        unit.bodyStartLine ?? 1,
      ]),
    )
    .digest("hex")
}

/**
 * The units of `next` that are new or differ from their stored row, and the
 * stored units that `next` does not have. A stored row without a hash counts
 * as changed. Two units with one serving id are an error, as for a full
 * write (the primary key refuses them).
 */
export function diffHydrateUnits(
  stored: ReadonlyArray<{ servingId: string; unitHash: string | null }>,
  next: readonly HydrateUnit[],
): { changed: HydrateUnit[]; removed: string[] } {
  const kept = new Set<string>()
  for (const unit of next) {
    if (kept.has(unit.servingId))
      throw new Error(`Two units have the serving id ${unit.servingId}`)
    kept.add(unit.servingId)
  }
  const hashes = new Map(stored.map((row) => [row.servingId, row.unitHash]))
  const changed = next.filter(
    (unit) => hashes.get(unit.servingId) !== hydrateUnitHash(unit),
  )
  const removed = stored
    .map((row) => row.servingId)
    .filter((servingId) => !kept.has(servingId))
  return { changed, removed }
}
