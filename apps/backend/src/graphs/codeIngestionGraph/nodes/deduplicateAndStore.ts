import { and, eq, inArray, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getOrgDb } from "../../../db/client.js"
import { claimEvidence } from "../../../db/schema/claim_evidence.js"
import { claims } from "../../../db/schema/claims.js"
import { retrievalObjects } from "../../../db/schema/retrieval_objects.js"
import { getLogger } from "../../../observability/logger.js"
import {
  addEvidence,
  createClaim,
} from "../../../retrieval/services/claimWrite.js"
import { aggregateConfidence } from "../../../retrieval/services/confidenceAggregation.js"
import { upsertRetrievalObjectByDeduplicationKey } from "../../../retrieval/services/retrievalObjectWrite.js"
import type { ClaimForProjection, CodeIngestionState } from "../schemas.js"
import { isIdRef } from "../schemas.js"

function resolveRef(ref: string, keyToId: Map<string, string>): string {
  if (isIdRef(ref)) return ref
  const id = keyToId.get(ref)
  if (id) return id
  throw new Error(`Unresolved ref: ${ref}`)
}

export async function deduplicateAndStore(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const logger = getLogger()
  logger.set({
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    roots: state.roots,
    extractedObjectsCount: state.extractedObjects?.length ?? 0,
    extractedClaimsCount: state.extractedClaims?.length ?? 0,
  })
  logger.info("deduplicating and storing")
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const { extractedObjects = [], extractedClaims = [] } = state

  const objectIds: string[] = []
  const claimsForProjection: ClaimForProjection[] = []
  const claimIdsToFetch: string[] = []
  const claimIdToKinds = new Map<
    string,
    { subjectKind: string; objectKind: string }
  >()
  const keyToId = new Map<string, string>()

  for (const obj of extractedObjects) {
    const existing = await db
      .select({ id: retrievalObjects.id })
      .from(retrievalObjects)
      .where(
        and(
          eq(retrievalObjects.orgId, orgId),
          eq(retrievalObjects.deduplicationKey, obj.deduplicationKey as string),
        ),
      )
      .limit(1)

    let id: string
    if (existing[0]) {
      id = existing[0].id
    } else {
      const payload: Record<string, unknown> = {
        name: obj.name,
        summary: obj.summary,
        ...(typeof obj.payload === "object" && obj.payload !== null
          ? obj.payload
          : {}),
      }
      id = await upsertRetrievalObjectByDeduplicationKey(orgId, {
        kind: obj.kind as string,
        deduplicationKey: obj.deduplicationKey,
        payload,
      })
    }
    keyToId.set(obj.deduplicationKey, id)
    objectIds.push(id)
  }

  const now = new Date()
  const nowIso = now.toISOString()

  for (const c of extractedClaims) {
    const subjectId = resolveRef(c.subjectRef, keyToId)
    const objectId = resolveRef(c.objectRef, keyToId)
    const subjectKind = c.subjectKind
    const objectKind = c.objectKind

    const existingClaimWithEvidence = await db
      .select({
        claimId: claims.id,
        sourceId: claimEvidence.sourceId,
      })
      .from(claims)
      .innerJoin(claimEvidence, eq(claims.id, claimEvidence.claimId))
      .where(
        and(
          eq(claims.orgId, orgId),
          eq(claims.subjectId, subjectId),
          eq(claims.predicate, c.predicate),
          eq(claims.objectId, objectId),
          eq(claimEvidence.sourceId, c.sourceId),
        ),
      )
      .limit(1)

    if (existingClaimWithEvidence[0]) {
      continue
    }

    const existingClaim = await db
      .select({ id: claims.id })
      .from(claims)
      .where(
        and(
          eq(claims.orgId, orgId),
          eq(claims.subjectId, subjectId),
          eq(claims.predicate, c.predicate),
          eq(claims.objectId, objectId),
        ),
      )
      .limit(1)

    if (existingClaim[0]) {
      await addEvidence({
        claimId: existingClaim[0].id,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        extractionMethod: c.extractionMethod,
        confidence: c.confidence,
        provenance: c.provenance ?? null,
      })
      claimIdsToFetch.push(existingClaim[0].id)
      claimIdToKinds.set(existingClaim[0].id, {
        subjectKind,
        objectKind,
      })
    } else {
      const claimId = await createClaim(
        {
          subjectId,
          predicate: c.predicate,
          objectId,
          subjectKind,
          objectKind,
        },
        {
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          extractionMethod: c.extractionMethod,
          confidence: c.confidence,
          provenance: c.provenance ?? null,
        },
      )
      const agg = aggregateConfidence([
        {
          sourceType: c.sourceType,
          extractionMethod: c.extractionMethod,
          confidence: c.confidence,
          observedAt: now,
        },
      ])
      claimsForProjection.push({
        id: claimId,
        subjectId,
        objectId,
        subjectKind,
        objectKind,
        predicate: c.predicate,
        status: "active",
        aggregatedConfidence: agg,
        sourceCount: 1,
        lastObservedAt: nowIso,
        validFrom: null,
        validTo: null,
      })
    }
  }

  if (claimIdsToFetch.length > 0) {
    const fetchedClaims = await db
      .select({
        id: claims.id,
        subjectId: claims.subjectId,
        objectId: claims.objectId,
        predicate: claims.predicate,
        status: claims.status,
        aggregatedConfidence: claims.aggregatedConfidence,
        lastObservedAt: claims.lastObservedAt,
        validFrom: claims.validFrom,
        validTo: claims.validTo,
      })
      .from(claims)
      .where(and(eq(claims.orgId, orgId), inArray(claims.id, claimIdsToFetch)))

    const evidenceCounts = Object.fromEntries(
      (
        await db
          .select({
            claimId: claimEvidence.claimId,
            count: sql<number>`count(*)::int`,
          })
          .from(claimEvidence)
          .where(inArray(claimEvidence.claimId, claimIdsToFetch))
          .groupBy(claimEvidence.claimId)
      ).map((r) => [r.claimId, r.count]),
    )

    for (const row of fetchedClaims) {
      const kinds = claimIdToKinds.get(row.id)
      if (!kinds) continue
      claimsForProjection.push({
        id: row.id,
        subjectId: row.subjectId,
        objectId: row.objectId,
        subjectKind: kinds.subjectKind,
        objectKind: kinds.objectKind,
        predicate: row.predicate,
        status: row.status,
        aggregatedConfidence: row.aggregatedConfidence,
        sourceCount: evidenceCounts[row.id] ?? 1,
        lastObservedAt: row.lastObservedAt.toISOString(),
        validFrom: row.validFrom?.toISOString() ?? null,
        validTo: row.validTo?.toISOString() ?? null,
      })
    }
  }

  return {
    objectIds: [...new Set(objectIds)],
    claimsForProjection,
  }
}
