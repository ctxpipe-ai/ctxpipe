import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"

export type HydratedClaim = {
  id: string
  orgId: string
  subjectId: string
  predicate: string
  objectId: string
  status: string
  validFrom: Date | null
  validTo: Date | null
  firstObservedAt: Date
  lastObservedAt: Date
  aggregatedConfidence: number
}

/**
 * Fetches claims by IDs from Postgres.
 * Must be called with org context; filters by orgId for tenant isolation.
 */
export async function hydrateClaims(
  orgId: string,
  claimIds: string[],
): Promise<HydratedClaim[]> {
  if (claimIds.length === 0) return []

  return withOrgDbContext(orgId, async (db) => {
    const rows = await db
      .select()
      .from(claims)
      .where(and(eq(claims.orgId, orgId), inArray(claims.id, claimIds)))

    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      subjectId: r.subjectId,
      predicate: r.predicate,
      objectId: r.objectId,
      status: r.status,
      validFrom: r.validFrom,
      validTo: r.validTo,
      firstObservedAt: r.firstObservedAt,
      lastObservedAt: r.lastObservedAt,
      aggregatedConfidence: r.aggregatedConfidence,
    }))
  })
}
