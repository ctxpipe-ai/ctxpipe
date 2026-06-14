import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lt,
} from "drizzle-orm"
import { getOrgDb } from "../db/client.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import { buildSourceLink } from "../lib/buildSourceLink.js"

export type KnowledgeGraphReviewObject = {
  id: string
  kind: string
  name: string | null
  summary: string | null
}

export type KnowledgeGraphReviewEvidence = {
  id: string
  sourceType: string
  sourceId: string
  sourceUrl: string | null
  sourceLink: string
  extractionMethod: string
  confidence: number
  observedAt: string
}

export type KnowledgeGraphReviewItem = {
  id: string
  predicate: string
  aggregatedConfidence: number
  lastObservedAt: string
  subject: KnowledgeGraphReviewObject
  object: KnowledgeGraphReviewObject
  evidence: KnowledgeGraphReviewEvidence[]
}

export type KnowledgeGraphReviewPayload = {
  total: number
  confidenceBelow: number
  limit: number
  items: KnowledgeGraphReviewItem[]
}

function payloadString(
  payload: unknown,
  key: "name" | "summary",
): string | null {
  if (!payload || typeof payload !== "object") return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null
}

export async function getKnowledgeGraphReview(input: {
  orgId: string
  orgSlug: string
  confidenceBelow?: number
  limit?: number
}): Promise<KnowledgeGraphReviewPayload> {
  const db = getOrgDb()
  const confidenceBelow = input.confidenceBelow ?? 0.7
  const limit = input.limit ?? 50
  const subject = aliasedTable(objects, "kg_review_subject")
  const object = aliasedTable(objects, "kg_review_object")

  const [totalRow, rows] = await Promise.all([
    db
      .select({ total: count() })
      .from(claims)
      .where(
        and(
          eq(claims.orgId, input.orgId),
          eq(claims.status, "active"),
          lt(claims.aggregatedConfidence, confidenceBelow),
        ),
      ),
    db
      .select({
        id: claims.id,
        predicate: claims.predicate,
        aggregatedConfidence: claims.aggregatedConfidence,
        lastObservedAt: claims.lastObservedAt,
        subjectId: subject.id,
        subjectKind: subject.kind,
        subjectPayload: subject.payload,
        objectId: object.id,
        objectKind: object.kind,
        objectPayload: object.payload,
      })
      .from(claims)
      .innerJoin(
        subject,
        and(eq(claims.subjectId, subject.id), eq(subject.orgId, input.orgId)),
      )
      .innerJoin(
        object,
        and(eq(claims.objectId, object.id), eq(object.orgId, input.orgId)),
      )
      .where(
        and(
          eq(claims.orgId, input.orgId),
          eq(claims.status, "active"),
          lt(claims.aggregatedConfidence, confidenceBelow),
        ),
      )
      .orderBy(asc(claims.aggregatedConfidence), desc(claims.lastObservedAt))
      .limit(limit),
  ])

  const claimIds = rows.map((row) => row.id)
  const evidenceRows =
    claimIds.length > 0
      ? await db
          .select({
            id: claimEvidence.id,
            claimId: claimEvidence.claimId,
            sourceType: claimEvidence.sourceType,
            sourceId: claimEvidence.sourceId,
            sourceUrl: claimEvidence.sourceUrl,
            extractionMethod: claimEvidence.extractionMethod,
            confidence: claimEvidence.confidence,
            observedAt: claimEvidence.observedAt,
          })
          .from(claimEvidence)
          .where(inArray(claimEvidence.claimId, claimIds))
          .orderBy(desc(claimEvidence.observedAt))
      : []

  const evidenceByClaimId = new Map<string, KnowledgeGraphReviewEvidence[]>()
  for (const evidence of evidenceRows) {
    const existing = evidenceByClaimId.get(evidence.claimId) ?? []
    existing.push({
      id: evidence.id,
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      sourceUrl: evidence.sourceUrl,
      sourceLink: buildSourceLink({
        orgSlug: input.orgSlug,
        sourceType: evidence.sourceType,
        sourceId: evidence.sourceId,
        sourceUrl: evidence.sourceUrl,
      }),
      extractionMethod: evidence.extractionMethod,
      confidence: evidence.confidence,
      observedAt: evidence.observedAt.toISOString(),
    })
    evidenceByClaimId.set(evidence.claimId, existing)
  }

  return {
    total: totalRow[0]?.total ?? 0,
    confidenceBelow,
    limit,
    items: rows.map((row) => ({
      id: row.id,
      predicate: row.predicate,
      aggregatedConfidence: row.aggregatedConfidence,
      lastObservedAt: row.lastObservedAt.toISOString(),
      subject: {
        id: row.subjectId,
        kind: row.subjectKind,
        name: payloadString(row.subjectPayload, "name"),
        summary: payloadString(row.subjectPayload, "summary"),
      },
      object: {
        id: row.objectId,
        kind: row.objectKind,
        name: payloadString(row.objectPayload, "name"),
        summary: payloadString(row.objectPayload, "summary"),
      },
      evidence: evidenceByClaimId.get(row.id) ?? [],
    })),
  }
}
