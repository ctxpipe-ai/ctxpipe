import { and, eq, inArray, sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"

export type ClaimAggregationRow = {
  objectId: string
  predicate: string
  subjectCount: number
}

const DEFAULT_LIMIT = 20

/**
 * Aggregates claims by predicate to surface fleet-wide patterns.
 * Returns objectId, predicate, and subject count for each (objectId, predicate) pair.
 * Use for "what database/library/framework is common?" style questions.
 */
export async function aggregateClaimsByPredicate(
  orgId: string,
  predicates: string[],
  options?: { limit?: number },
): Promise<ClaimAggregationRow[]> {
  if (predicates.length === 0) return []

  const limit = Math.min(50, Math.max(1, options?.limit ?? DEFAULT_LIMIT))

  return withOrgDbContext(orgId, async (db) => {
    const rows = await db
      .select({
        objectId: claims.objectId,
        predicate: claims.predicate,
        subjectCount: sql<number>`count(distinct ${claims.subjectId})::int`,
      })
      .from(claims)
      .where(
        and(
          eq(claims.orgId, orgId),
          eq(claims.status, "active"),
          inArray(claims.predicate, predicates),
        ),
      )
      .groupBy(claims.objectId, claims.predicate)
      .orderBy(sql`count(distinct ${claims.subjectId}) desc`)
      .limit(limit)

    return rows.map((r) => ({
      objectId: r.objectId,
      predicate: r.predicate,
      subjectCount: r.subjectCount,
    }))
  })
}
