import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
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

export type HydratedEvidence = {
  id: string
  claimId: string
  sourceType: string
  sourceId: string
  sourceUrl: string | null
  extractionMethod: string
  confidence: number
  observedAt: Date
  validFrom: Date | null
  validTo: Date | null
  provenance: Record<string, unknown> | null
}

export type HydratedClaimWithEvidence = HydratedClaim & {
  evidence: HydratedEvidence[]
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

/**
 * Fetches claims with their evidence from Postgres.
 * Returns claims with provenance (sourceType, sourceId, extractionMethod) for each evidence record.
 */
export async function hydrateClaimsWithEvidence(
  orgId: string,
  claimIds: string[],
): Promise<HydratedClaimWithEvidence[]> {
  if (claimIds.length === 0) return []

  return withOrgDbContext(orgId, async (db) => {
    const claimRows = await db
      .select()
      .from(claims)
      .where(and(eq(claims.orgId, orgId), inArray(claims.id, claimIds)))

    const evidenceRows = await db
      .select()
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, claimIds))

    const evidenceByClaimId = new Map<string, typeof evidenceRows>()
    for (const ev of evidenceRows) {
      const list = evidenceByClaimId.get(ev.claimId) ?? []
      list.push(ev)
      evidenceByClaimId.set(ev.claimId, list)
    }

    return claimRows.map((r) => ({
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
      evidence: (evidenceByClaimId.get(r.id) ?? []).map((ev) => ({
        id: ev.id,
        claimId: ev.claimId,
        sourceType: ev.sourceType,
        sourceId: ev.sourceId,
        sourceUrl: ev.sourceUrl,
        extractionMethod: ev.extractionMethod,
        confidence: ev.confidence,
        observedAt: ev.observedAt,
        validFrom: ev.validFrom,
        validTo: ev.validTo,
        provenance: ev.provenance as Record<string, unknown> | null,
      })),
    }))
  })
}
