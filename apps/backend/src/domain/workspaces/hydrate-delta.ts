import { createHash } from "node:crypto"

import { type HydrateUnit, REFERENCE_INDEX_VERSION } from "./hydrate.js"
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
 * - `chunks_missing`: a unit of the active projection has no chunk rows.
 * - `lineage`: the active projection has another generation, remote,
 *   connection or default branch.
 * - `format_changed`: the Workspace format of the new tree is not the cached
 *   format of the active projection.
 * - `base_moved`: another hydrate changed the active projection after this
 *   run selected its base.
 * - `unit_bound`: too many units changed (`partialUnitBound`). A new
 *   embedding model changes the hash of each unit, so it also gives this
 *   reason.
 *
 * `hydrateCommitBase` selects the first five reasons, which need no lock.
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
  | "chunks_missing"
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
  chunksMissing: boolean
  formatChanged: boolean
}): HydrateCommitBase {
  const { projection } = input
  if (input.reproject) return { fullReason: "reproject" }
  if (input.chunksMissing) return { fullReason: "chunks_missing" }
  if (projection?.kind !== "active") return { fullReason: "no_base" }
  if (!sameWorkspaceBinding(projection.revision, input.revision))
    return { fullReason: "lineage" }
  if (input.formatChanged) return { fullReason: "format_changed" }
  return { revision: projection.revision }
}

/**
 * The maximum number of changed and removed units for a partial write: 10%
 * of the stored units, at most 200. A partial write uses one upsert for each
 * changed row and reads the chunk keys of the changed units only. A full
 * write uses one insert for each 500 rows and reads the keys of all chunks
 * once. Above about 10% of the units, the partial statements cost about as
 * much as the full rewrite. Above 200 units, the graph delta (one atomic
 * graph query) gets large, and the graph store blocks the org graph while
 * that query runs.
 */
export function partialUnitBound(storedUnits: number): number {
  return Math.min(200, Math.ceil(storedUnits * 0.1))
}

/**
 * A hash of each value that hydrate stores for a unit or derives from it:
 * the row columns with the reference index, the first body line, which sets
 * the chunk lines, and the embedding model, which sets the chunk hashes and
 * vectors. When the model changes, the next hydrate parses all files
 * (`embedding_model`). Each stored hash then differs, so the hydrate writes
 * all units (`unit_bound`) and embeds them again.
 */
export function hydrateUnitHash(
  unit: HydrateUnit,
  embeddingModel: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        // The parse version. A partial parse keeps the stored rows of the
        // files that did not change, so the hash has no version of its own:
        // a change of the hashed values raises `REFERENCE_INDEX_VERSION`,
        // which gives a full parse.
        REFERENCE_INDEX_VERSION,
        embeddingModel,
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
        canonicalJson(unit.referenceIndex ?? null),
      ]),
    )
    .digest("hex")
}

/**
 * The value with the keys of each object in sorted order. Postgres stores
 * jsonb with its own key order, so a value that hydrate reads back from a
 * row gives the same hash as the value that hydrate wrote.
 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalJson(item)]),
    )
  return value
}

/**
 * The units of `next` that are new or differ from their stored row, and the
 * stored units that `next` does not have. A stored row without a hash counts
 * as changed. Two units with one serving id are an error, as for a full
 * write (the primary key refuses them). With `removedUnitIds` (a partial
 * parse), `next` holds only the units that the parse made again: the
 * removed units are the stored units of that list, and each other stored
 * unit stays.
 */
export function diffHydrateUnits(
  stored: ReadonlyArray<{ servingId: string; unitHash: string | null }>,
  next: readonly HydrateUnit[],
  embeddingModel: string,
  removedUnitIds?: readonly string[],
): { changed: HydrateUnit[]; removed: string[] } {
  const kept = new Set<string>()
  for (const unit of next) {
    if (kept.has(unit.servingId))
      throw new Error(`Two units have the serving id ${unit.servingId}`)
    kept.add(unit.servingId)
  }
  const hashes = new Map(stored.map((row) => [row.servingId, row.unitHash]))
  const changed = next.filter(
    (unit) =>
      hashes.get(unit.servingId) !== hydrateUnitHash(unit, embeddingModel),
  )
  const removedIds = removedUnitIds ? new Set(removedUnitIds) : null
  const removed = stored
    .map((row) => row.servingId)
    .filter((servingId) =>
      removedIds ? removedIds.has(servingId) : !kept.has(servingId),
    )
  return { changed, removed }
}
