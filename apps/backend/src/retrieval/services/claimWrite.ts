import { eq, inArray } from "drizzle-orm"
import type { z } from "zod/v3"
import { requireCurrentOrgId } from "../../auth/context.js"
import { getOrgDb } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { generateObjectId } from "../../lib/id.js"
import { isAllowedConnection } from "../schema/allowedConnections.js"
import type { ExtractionMethod, SourceType } from "../schema/claims.js"
import { validatePredicate } from "../schema/predicateValidation.js"

type SourceTypeValue = z.infer<typeof SourceType>
type ExtractionMethodValue = z.infer<typeof ExtractionMethod>

import { aggregateConfidence } from "./confidenceAggregation.js"

const ID_PREFIX_TO_KIND: Record<string, string> = {
  repo_: "Repository",
  svc_: "Service",
  app_: "App",
  api_: "API",
  str_: "Stream",
  db_: "Database",
  inf_: "Infrastructure",
  lib_: "Library",
  pat_: "Pattern",
  con_: "Concept",
  cap_: "Capability",
  top_: "Topic",
  inc_: "Incident",
  dec_: "Decision",
  inu_: "InstructionUnit",
  skl_: "Skill",
}

function deriveKindFromId(id: string): string {
  for (const [prefix, kind] of Object.entries(ID_PREFIX_TO_KIND)) {
    if (id.startsWith(prefix)) return kind
  }
  return "Entity"
}

export type CreateClaimInput = {
  subjectId: string
  predicate: string
  objectId: string
  status?: "active" | "superseded" | "disputed" | "deprecated"
  /** When the fact was valid in the world (optional; null = evergreen) */
  validFrom?: Date | null
  validTo?: Date | null
  /** Optional: override derived kinds for allowed-connection validation */
  subjectKind?: string
  objectKind?: string
}

export type AddEvidenceInput = {
  claimId: string
  sourceType: SourceTypeValue
  sourceId: string
  /** Stable dedup / retraction key (optional; null = legacy rows) */
  logicalSourceKey?: string | null
  sourceUrl?: string | null
  extractionMethod: ExtractionMethodValue
  confidence: number
  provenance?: Record<string, unknown> | null
}

export type InitialEvidenceInput = Omit<AddEvidenceInput, "claimId">

/** Chunk size for bulk claim / evidence inserts. */
export const CLAIM_WRITE_BATCH_SIZE = 500

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function validateClaimConnection(input: CreateClaimInput): {
  subjectKind: string
  objectKind: string
} {
  validatePredicate(input.predicate)
  const subjectKind = input.subjectKind ?? deriveKindFromId(input.subjectId)
  const objectKind = input.objectKind ?? deriveKindFromId(input.objectId)
  if (
    subjectKind !== "Entity" &&
    objectKind !== "Entity" &&
    !isAllowedConnection(subjectKind, input.predicate, objectKind)
  ) {
    throw new Error(
      `Invalid connection: ${subjectKind} --[${input.predicate}]--> ${objectKind}. Check getAllowedConnections().`,
    )
  }
  return { subjectKind, objectKind }
}

export type BulkCreateClaimWithEvidenceItem = {
  /** Pre-generated claim id (caller may already queue projection against it). */
  claimId: string
  claim: CreateClaimInput
  evidence: InitialEvidenceInput
}

/**
 * Creates a claim and optionally adds initial evidence.
 * Recomputes aggregated confidence from all evidence.
 * Validates predicate against schema (CoreRelType, ExtensionRelType, or allowed ingestion predicates).
 */
export async function createClaim(
  input: CreateClaimInput,
  initialEvidence?: InitialEvidenceInput,
): Promise<string> {
  validateClaimConnection(input)

  const claimId = generateObjectId("claim")
  const now = new Date()
  const db = getOrgDb()
  const resolvedOrgId = requireCurrentOrgId()

  if (initialEvidence) {
    await db.transaction(async (tx) => {
      await tx.insert(claims).values({
        id: claimId,
        orgId: resolvedOrgId,
        subjectId: input.subjectId,
        predicate: input.predicate,
        objectId: input.objectId,
        status: input.status ?? "active",
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        firstObservedAt: now,
        lastObservedAt: now,
        aggregatedConfidence: aggregateConfidence([
          {
            sourceType: initialEvidence.sourceType,
            extractionMethod: initialEvidence.extractionMethod,
            confidence: initialEvidence.confidence,
            observedAt: now,
          },
        ]),
      })

      const evId = generateObjectId("ev")
      await tx.insert(claimEvidence).values({
        id: evId,
        claimId,
        sourceType: initialEvidence.sourceType,
        sourceId: initialEvidence.sourceId,
        logicalSourceKey: initialEvidence.logicalSourceKey ?? null,
        sourceUrl: initialEvidence.sourceUrl ?? null,
        extractionMethod: initialEvidence.extractionMethod,
        confidence: initialEvidence.confidence,
        observedAt: now,
        provenance: initialEvidence.provenance ?? null,
      })
    })
  } else {
    await db.insert(claims).values({
      id: claimId,
      orgId: resolvedOrgId,
      subjectId: input.subjectId,
      predicate: input.predicate,
      objectId: input.objectId,
      status: input.status ?? "active",
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      firstObservedAt: now,
      lastObservedAt: now,
      aggregatedConfidence: 0,
    })
  }

  return claimId
}

/**
 * Bulk-insert new claims with their initial evidence (chunked). Validates all
 * connections first. Does not open a nested transaction per claim.
 */
export async function createClaimsWithEvidenceBulk(
  items: BulkCreateClaimWithEvidenceItem[],
): Promise<void> {
  if (items.length === 0) return

  for (const item of items) {
    validateClaimConnection(item.claim)
  }

  const now = new Date()
  const db = getOrgDb()
  const resolvedOrgId = requireCurrentOrgId()

  for (const chunk of chunkArray(items, CLAIM_WRITE_BATCH_SIZE)) {
    await db.insert(claims).values(
      chunk.map((item) => ({
        id: item.claimId,
        orgId: resolvedOrgId,
        subjectId: item.claim.subjectId,
        predicate: item.claim.predicate,
        objectId: item.claim.objectId,
        status: item.claim.status ?? "active",
        validFrom: item.claim.validFrom ?? null,
        validTo: item.claim.validTo ?? null,
        firstObservedAt: now,
        lastObservedAt: now,
        aggregatedConfidence: aggregateConfidence([
          {
            sourceType: item.evidence.sourceType,
            extractionMethod: item.evidence.extractionMethod,
            confidence: item.evidence.confidence,
            observedAt: now,
          },
        ]),
      })),
    )

    await db.insert(claimEvidence).values(
      chunk.map((item) => ({
        id: generateObjectId("ev"),
        claimId: item.claimId,
        sourceType: item.evidence.sourceType,
        sourceId: item.evidence.sourceId,
        logicalSourceKey: item.evidence.logicalSourceKey ?? null,
        sourceUrl: item.evidence.sourceUrl ?? null,
        extractionMethod: item.evidence.extractionMethod,
        confidence: item.evidence.confidence,
        observedAt: now,
        provenance: item.evidence.provenance ?? null,
      })),
    )
  }
}

/**
 * Bulk-insert evidence rows, then recompute aggregated confidence once per
 * affected claim (chunked selects/updates).
 */
export async function addEvidenceBulk(
  inputs: AddEvidenceInput[],
): Promise<void> {
  if (inputs.length === 0) return

  const now = new Date()
  const db = getOrgDb()

  for (const chunk of chunkArray(inputs, CLAIM_WRITE_BATCH_SIZE)) {
    await db.insert(claimEvidence).values(
      chunk.map((input) => ({
        id: generateObjectId("ev"),
        claimId: input.claimId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        logicalSourceKey: input.logicalSourceKey ?? null,
        sourceUrl: input.sourceUrl ?? null,
        extractionMethod: input.extractionMethod,
        confidence: input.confidence,
        observedAt: now,
        provenance: input.provenance ?? null,
      })),
    )
  }

  const claimIds = [...new Set(inputs.map((i) => i.claimId))]
  for (const idChunk of chunkArray(claimIds, CLAIM_WRITE_BATCH_SIZE)) {
    const allEvidence = await db
      .select({
        claimId: claimEvidence.claimId,
        sourceType: claimEvidence.sourceType,
        extractionMethod: claimEvidence.extractionMethod,
        confidence: claimEvidence.confidence,
        observedAt: claimEvidence.observedAt,
      })
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, idChunk))

    const byClaim = new Map<
      string,
      Array<{
        sourceType: SourceTypeValue
        extractionMethod: ExtractionMethodValue
        confidence: number
        observedAt: Date
      }>
    >()
    for (const e of allEvidence) {
      const list = byClaim.get(e.claimId) ?? []
      list.push({
        sourceType: e.sourceType as SourceTypeValue,
        extractionMethod: e.extractionMethod as ExtractionMethodValue,
        confidence: e.confidence,
        observedAt: e.observedAt,
      })
      byClaim.set(e.claimId, list)
    }

    await Promise.all(
      idChunk.map(async (claimId) => {
        const evidence = byClaim.get(claimId) ?? []
        const aggregated = aggregateConfidence(evidence)
        const first = evidence[0]
        const lastObserved = first
          ? evidence.reduce(
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
          .where(eq(claims.id, claimId))
      }),
    )
  }
}

/**
 * Adds evidence to an existing claim and recomputes aggregated confidence.
 */
export async function addEvidence(input: AddEvidenceInput): Promise<string> {
  const evId = generateObjectId("ev")
  const now = new Date()
  const db = getOrgDb()

  return db.transaction(async (tx) => {
    await tx.insert(claimEvidence).values({
      id: evId,
      claimId: input.claimId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      logicalSourceKey: input.logicalSourceKey ?? null,
      sourceUrl: input.sourceUrl ?? null,
      extractionMethod: input.extractionMethod,
      confidence: input.confidence,
      observedAt: now,
      provenance: input.provenance ?? null,
    })

    const allEvidence = await tx
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

    await tx
      .update(claims)
      .set({
        aggregatedConfidence: aggregated,
        lastObservedAt: lastObserved,
        updatedAt: now,
      })
      .where(eq(claims.id, input.claimId))

    return evId
  })
}
