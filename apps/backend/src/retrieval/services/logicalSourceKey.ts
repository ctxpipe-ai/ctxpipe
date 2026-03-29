import type { SQL } from "drizzle-orm"
import { sql } from "drizzle-orm"
import type { claimEvidence } from "../../db/schema/claim_evidence.js"

/**
 * Derives a stable logical source key from a trace `sourceId` by stripping a
 * trailing `:${targetHash}` segment when present (codesearch snapshot identity).
 */
export function deriveLogicalSourceKey(
  sourceId: string,
  targetHash: string,
): string {
  const suffix = `:${targetHash}`
  if (sourceId.endsWith(suffix)) {
    return sourceId.slice(0, -suffix.length)
  }
  return sourceId
}

/**
 * SQL expression matching {@link deriveLogicalSourceKey} for duplicate checks
 * on rows with legacy `logical_source_key` null.
 */
export function deriveLogicalSourceKeySql(
  sourceIdColumn: typeof claimEvidence.sourceId,
  targetHash: string,
): SQL<string> {
  const suffix = `:${targetHash}`
  return sql<string>`CASE WHEN right(${sourceIdColumn}, ${suffix.length}) = ${suffix} THEN left(${sourceIdColumn}, length(${sourceIdColumn}) - ${suffix.length}) ELSE ${sourceIdColumn} END`
}
