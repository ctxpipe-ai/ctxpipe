import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { generateObjectId } from "../../lib/id.js"
import type { z } from "zod/v3"
import type { ExtractionMethod, SourceType } from "../schema/claims.js"

type SourceTypeValue = z.infer<typeof SourceType>
type ExtractionMethodValue = z.infer<typeof ExtractionMethod>
import { aggregateConfidence } from "./confidenceAggregation.js"

export type CreateClaimInput = {
  subjectId: string
  predicate: string
  objectId: string
  status?: "active" | "superseded" | "disputed" | "deprecated"
}

export type AddEvidenceInput = {
  claimId: string
  sourceType: SourceTypeValue
  sourceId: string
  sourceUrl?: string | null
  extractionMethod: ExtractionMethodValue
  confidence: number
  provenance?: Record<string, unknown> | null
}

export type InitialEvidenceInput = Omit<
  AddEvidenceInput,
  "claimId"
>

/**
 * Creates a claim and optionally adds initial evidence.
 * Recomputes aggregated confidence from all evidence.
 */
export async function createClaim(
  orgId: string,
  input: CreateClaimInput,
  initialEvidence?: InitialEvidenceInput,
): Promise<string> {
  const claimId = generateObjectId("claim")
  const now = new Date()

  await withOrgDbContext(orgId, async (db) => {
    await db.insert(claims).values({
      id: claimId,
      orgId,
      subjectId: input.subjectId,
      predicate: input.predicate,
      objectId: input.objectId,
      status: input.status ?? "active",
      firstObservedAt: now,
      lastObservedAt: now,
      aggregatedConfidence: initialEvidence
        ? aggregateConfidence([
            {
              sourceType: initialEvidence.sourceType,
              extractionMethod: initialEvidence.extractionMethod,
              confidence: initialEvidence.confidence,
              observedAt: now,
            },
          ])
        : 0,
    })

    if (initialEvidence) {
      const evId = generateObjectId("ev")
      await db.insert(claimEvidence).values({
        id: evId,
        claimId,
        sourceType: initialEvidence.sourceType,
        sourceId: initialEvidence.sourceId,
        sourceUrl: initialEvidence.sourceUrl ?? null,
        extractionMethod: initialEvidence.extractionMethod,
        confidence: initialEvidence.confidence,
        observedAt: now,
        provenance: initialEvidence.provenance ?? null,
      })
    }
  })

  return claimId
}

/**
 * Adds evidence to an existing claim and recomputes aggregated confidence.
 */
export async function addEvidence(
  orgId: string,
  input: AddEvidenceInput,
): Promise<string> {
  const evId = generateObjectId("ev")
  const now = new Date()

  await withOrgDbContext(orgId, async (db) => {
    await db.insert(claimEvidence).values({
      id: evId,
      claimId: input.claimId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl ?? null,
      extractionMethod: input.extractionMethod,
      confidence: input.confidence,
      observedAt: now,
      provenance: input.provenance ?? null,
    })

    const allEvidence = await db
      .select({
        sourceType: claimEvidence.sourceType,
        extractionMethod: claimEvidence.extractionMethod,
        confidence: claimEvidence.confidence,
        observedAt: claimEvidence.observedAt,
      })
      .from(claimEvidence)
      .where(eq(claimEvidence.claimId, input.claimId))

    const aggregated = aggregateConfidence(
      allEvidence.map((e) => ({
        sourceType: e.sourceType as SourceTypeValue,
        extractionMethod: e.extractionMethod as ExtractionMethodValue,
        confidence: e.confidence,
        observedAt: e.observedAt,
      })),
    )

    const first = allEvidence[0]
    const lastObserved = first
      ? allEvidence.reduce(
          (max, e) => (e.observedAt > max ? e.observedAt : max),
          first.observedAt,
        )
      : now

    await db
      .update(claims)
      .set({
        aggregatedConfidence: aggregated,
        lastObservedAt: lastObserved,
        updatedAt: now,
      })
      .where(eq(claims.id, input.claimId))
  })

  return evId
}
