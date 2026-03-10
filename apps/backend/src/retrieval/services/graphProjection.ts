import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getOrgDb } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { retrievalObjects } from "../../db/schema/retrieval_objects.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { isValidPredicate } from "../schema/predicateValidation.js"

const CORE_ARCHITECTURE_TYPES = new Set([
  "Service",
  "API",
  "Stream",
  "Database",
  "Infrastructure",
  "Library",
  "Pattern",
])
const EXTENSION_TYPES = new Set([
  "Concept",
  "Capability",
  "Topic",
  "Incident",
  "Decision",
])

/**
 * Derives schema-constrained node label from ID prefix and optional type from retrieval_objects.
 * When typeFromDb is a core/extension architecture type, uses Entity:Type (e.g. Entity:Service).
 * Otherwise Entity for unknown IDs.
 */
function deriveNodeLabel(
  id: string,
  typeFromDb?: string | null,
): "Entity" | "Repository" {
  if (id.startsWith("repo_")) return "Repository"
  if (
    typeFromDb &&
    (CORE_ARCHITECTURE_TYPES.has(typeFromDb) || EXTENSION_TYPES.has(typeFromDb))
  ) {
    return "Entity"
  }
  if (id.startsWith("svc_")) return "Entity"
  if (id.startsWith("api_")) return "Entity"
  return "Entity"
}

/** Builds Cypher label list for MERGE; Entity is base; Repository add secondary label. */
function toCypherLabels(
  label: "Entity" | "Repository",
  typeFromDb?: string | null,
): string {
  if (label === "Repository") return "Entity:Repository"
  if (
    typeFromDb &&
    (CORE_ARCHITECTURE_TYPES.has(typeFromDb) || EXTENSION_TYPES.has(typeFromDb))
  ) {
    return `Entity:${typeFromDb}`
  }
  return "Entity"
}

/**
 * Projects active claims from Postgres into FalkorDB.
 * Creates/merges nodes (subject, object) with schema-derived labels and edges with
 * claim_id, aggregate_confidence, source_count, last_observed_at.
 * Skips claims with invalid predicates. Uses parameterized Cypher and org filter.
 * When validAt is provided, excludes claims outside validity window.
 */
export async function projectClaimsToGraph(options?: {
  claimIds?: string[]
  validAt?: Date
}): Promise<{ projected: number; errors: string[] }> {
  const errors: string[] = []
  let projected = 0
  const db = getOrgDb()
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  let where = and(eq(claims.orgId, resolvedOrgId), eq(claims.status, "active"))
  if (options?.claimIds?.length) {
    where = and(where, inArray(claims.id, options.claimIds))
  }
  if (options?.validAt) {
    const validAt = options.validAt
    where = and(
      where,
      or(
        and(isNull(claims.validFrom), isNull(claims.validTo)),
        and(isNull(claims.validFrom), gte(claims.validTo, validAt)),
        and(isNull(claims.validTo), lte(claims.validFrom, validAt)),
        and(lte(claims.validFrom, validAt), gte(claims.validTo, validAt)),
      ),
    )
  }
  const activeClaims = await db.select().from(claims).where(where)

  if (activeClaims.length === 0) return { projected: 0, errors: [] }

  const entityIds = [
    ...new Set(activeClaims.flatMap((c) => [c.subjectId, c.objectId])),
  ]
  const typeByEntityId =
    entityIds.length === 0
      ? ({} as Record<string, string>)
      : Object.fromEntries(
          (
            await db
              .select({ id: retrievalObjects.id, type: retrievalObjects.type })
              .from(retrievalObjects)
              .where(
                and(
                  eq(retrievalObjects.orgId, resolvedOrgId),
                  inArray(retrievalObjects.id, entityIds),
                ),
              )
          ).map((r) => [r.id, r.type]),
        )

  const claimIdsForEvidence = activeClaims.map((c) => c.id)
  const evidenceCounts = Object.fromEntries(
    (
      await db
        .select({
          claimId: claimEvidence.claimId,
          count: sql<number>`count(*)::int`,
        })
        .from(claimEvidence)
        .where(inArray(claimEvidence.claimId, claimIdsForEvidence))
        .groupBy(claimEvidence.claimId)
    ).map((r) => [r.claimId, r.count]),
  )

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()

      for (const c of activeClaims) {
        if (!isValidPredicate(c.predicate)) {
          errors.push(`${c.id}: invalid predicate "${c.predicate}", skipped`)
          continue
        }

        try {
          const sourceCount = evidenceCounts[c.id] ?? 1
          const subjectTypeFromDb = typeByEntityId[c.subjectId]
          const objectTypeFromDb = typeByEntityId[c.objectId]
          const subjectLabels = toCypherLabels(
            deriveNodeLabel(c.subjectId, subjectTypeFromDb),
            subjectTypeFromDb,
          )
          const objectLabels = toCypherLabels(
            deriveNodeLabel(c.objectId, objectTypeFromDb),
            objectTypeFromDb,
          )
          const subjectType =
            subjectTypeFromDb ??
            (c.subjectId.startsWith("svc_")
              ? "Service"
              : c.subjectId.startsWith("api_")
                ? "API"
                : null)
          const objectType =
            objectTypeFromDb ??
            (c.objectId.startsWith("svc_")
              ? "Service"
              : c.objectId.startsWith("api_")
                ? "API"
                : null)

          await driver.executeQuery(
            `MERGE (s:${subjectLabels} { id: $subjectId, orgId: $orgId })
           MERGE (o:${objectLabels} { id: $objectId, orgId: $orgId })
           SET s.type = COALESCE($subjectType, s.type),
               o.type = COALESCE($objectType, o.type)
           MERGE (s)-[r:CLAIMED]->(o)
           SET r.claim_id = $claimId,
               r.predicate = $predicate,
               r.aggregate_confidence = $aggregateConfidence,
               r.source_count = $sourceCount,
               r.last_observed_at = $lastObservedAt,
               r.valid_from = $validFrom,
               r.valid_to = $validTo
           RETURN r`,
            {
              subjectId: c.subjectId,
              objectId: c.objectId,
              orgId: resolvedOrgId,
              subjectType,
              objectType,
              claimId: c.id,
              predicate: c.predicate,
              aggregateConfidence: c.aggregatedConfidence,
              sourceCount,
              lastObservedAt: c.lastObservedAt.toISOString(),
              validFrom: c.validFrom?.toISOString() ?? null,
              validTo: c.validTo?.toISOString() ?? null,
            },
          )
          projected++
        } catch (err) {
          errors.push(
            `${c.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    },
  )

  return { projected, errors }
}
