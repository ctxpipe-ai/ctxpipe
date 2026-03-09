import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"

/**
 * Projects active claims from Postgres into FalkorDB.
 * Creates/merges nodes (subject, object) and edges with claim_id, aggregate_confidence,
 * source_count, last_observed_at. Uses parameterized Cypher and org filter.
 */
export async function projectClaimsToGraph(
  orgId: string,
  orgSlug: string,
  options?: { claimIds?: string[] },
): Promise<{ projected: number; errors: string[] }> {
  const errors: string[] = []
  let projected = 0

  const activeClaims = await withOrgDbContext(orgId, async (db) => {
    const baseWhere = and(eq(claims.orgId, orgId), eq(claims.status, "active"))
    if (options?.claimIds?.length) {
      return db
        .select()
        .from(claims)
        .where(and(baseWhere, inArray(claims.id, options.claimIds)))
    }
    return db.select().from(claims).where(baseWhere)
  })

  if (activeClaims.length === 0) return { projected: 0, errors: [] }

  const evidenceCounts = await withOrgDbContext(orgId, async (db) => {
    const { sql } = await import("drizzle-orm")
    const claimIds = activeClaims.map((c) => c.id)
    const rows = await db
      .select({
        claimId: claimEvidence.claimId,
        count: sql<number>`count(*)::int`,
      })
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, claimIds))
      .groupBy(claimEvidence.claimId)
    return Object.fromEntries(rows.map((r) => [r.claimId, r.count]))
  })

  await withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()

    for (const c of activeClaims) {
      try {
        const sourceCount = evidenceCounts[c.id] ?? 1
        await driver.executeQuery(
          `MERGE (s:Entity { id: $subjectId, orgId: $orgId })
           MERGE (o:Entity { id: $objectId, orgId: $orgId })
           MERGE (s)-[r:CLAIMED]->(o)
           SET r.claim_id = $claimId,
               r.predicate = $predicate,
               r.aggregate_confidence = $aggregateConfidence,
               r.source_count = $sourceCount,
               r.last_observed_at = $lastObservedAt
           RETURN r`,
          {
            subjectId: c.subjectId,
            objectId: c.objectId,
            orgId,
            claimId: c.id,
            predicate: c.predicate,
            aggregateConfidence: c.aggregatedConfidence,
            sourceCount,
            lastObservedAt: c.lastObservedAt.toISOString(),
          },
        )
        projected++
      } catch (err) {
        errors.push(
          `${c.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  })

  return { projected, errors }
}
