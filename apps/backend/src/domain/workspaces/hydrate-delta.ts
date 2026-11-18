import { createHash } from "node:crypto"

import type { HydrateUnit } from "./hydrate.js"

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
 * - `duplicate_units`: two units have one path. The full write refuses them.
 * - `unit_bound`: too many units changed (`partialUnitBound`).
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
  | "duplicate_units"
  | "unit_bound"

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
 * Increase this number when the hashed values change. Each stored hash then
 * differs, so the next hydrate writes all units (`unit_bound`).
 */
const UNIT_HASH_VERSION = 1

/**
 * A hash of each value that hydrate stores for a unit or derives from it:
 * the row columns, and the first body line, which sets the chunk lines.
 */
export function hydrateUnitHash(unit: HydrateUnit): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        UNIT_HASH_VERSION,
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
 * as changed.
 */
export function diffHydrateUnits(
  stored: ReadonlyArray<{ servingId: string; unitHash: string | null }>,
  next: readonly HydrateUnit[],
): { changed: HydrateUnit[]; removed: string[] } {
  const hashes = new Map(stored.map((row) => [row.servingId, row.unitHash]))
  const changed = next.filter(
    (unit) => hashes.get(unit.servingId) !== hydrateUnitHash(unit),
  )
  const kept = new Set(next.map((unit) => unit.servingId))
  const removed = stored
    .map((row) => row.servingId)
    .filter((servingId) => !kept.has(servingId))
  return { changed, removed }
}

/**
 * The unit as hydrate stores it: the graph and the chunks of a partial write
 * use only these values, as a full write that reads Postgres does.
 */
export function storedUnitShape(unit: HydrateUnit): HydrateUnit {
  return {
    servingId: unit.servingId,
    path: unit.path,
    kind: unit.kind ?? null,
    title: unit.title ?? null,
    source: unit.source ?? "authored",
    body: unit.body,
    links: unit.links,
    claims: unit.claims,
    updatedAt: unit.updatedAt,
  }
}
