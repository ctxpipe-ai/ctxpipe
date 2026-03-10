import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import type { ClaimForProjection } from "../schema/claimForProjection.js"

/**
 * Projects claims from graph state into FalkorDB.
 * No filtering, no derivation — saves as-is. Uses plain labels (e.g. Service, Repository).
 */
export async function projectClaimsFromState(
  claims: ClaimForProjection[],
): Promise<{ projected: number; errors: string[] }> {
  const errors: string[] = []
  let projected = 0
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  if (claims.length === 0) {
    console.debug("projectClaimsFromState: no claims to project")
    return { projected: 0, errors: [] }
  }

  console.debug(
    "projectClaimsFromState: projecting",
    claims.length,
    "claims to graph",
  )

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()

      for (const c of claims) {
        console.debug(
          "projectClaimsFromState: claim",
          c.id,
          c.subjectId,
          c.predicate,
          c.objectId,
        )

        try {
          const subjectLabel = c.subjectType
          const objectLabel = c.objectType

          await driver.executeQuery(
            `MERGE (s:${subjectLabel} { id: $subjectId, orgId: $orgId })
             MERGE (o:${objectLabel} { id: $objectId, orgId: $orgId })
             SET s.type = $subjectType,
                 o.type = $objectType
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
              subjectType: c.subjectType,
              objectType: c.objectType,
              claimId: c.id,
              predicate: c.predicate,
              aggregateConfidence: c.aggregatedConfidence,
              sourceCount: c.sourceCount,
              lastObservedAt: c.lastObservedAt,
              validFrom: c.validFrom,
              validTo: c.validTo,
            },
          )
          projected++
        } catch (err) {
          const details: Record<string, unknown> = {
            claimId: c.id,
            subjectId: c.subjectId,
            objectId: c.objectId,
            subjectType: c.subjectType,
            objectType: c.objectType,
            predicate: c.predicate,
            error: err instanceof Error ? err.message : String(err),
          }
          if (err && typeof err === "object" && "gqlStatus" in err) {
            const ne = err as {
              gqlStatus?: string
              gqlStatusDescription?: string
              code?: string
              diagnosticRecord?: unknown
            }
            details.gqlStatus = ne.gqlStatus
            details.gqlStatusDescription = ne.gqlStatusDescription
            details.code = ne.code
            details.diagnosticRecord = ne.diagnosticRecord
          }
          console.error("projectClaimsFromState: error projecting claim", details)
          errors.push(
            `${c.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    },
  )

  if (errors.length > 0) {
    throw new Error(
      `Graph projection failed: ${errors.length}/${claims.length} claims (${errors[0]}${errors.length > 1 ? ` and ${errors.length - 1} more` : ""})`,
    )
  }

  return { projected, errors }
}
