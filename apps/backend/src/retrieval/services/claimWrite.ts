import { eq } from "drizzle-orm"
import { getOrgDb } from "../../db/client.js"
import { requireCurrentOrgId } from "../../auth/context.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { generateObjectId } from "../../lib/id.js"
import type { z } from "zod/v3"
import type { ExtractionMethod, SourceType } from "../schema/claims.js"
import { isAllowedConnection } from "../schema/allowedConnections.js"
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
  sourceUrl?: string | null
  extractionMethod: ExtractionMethodValue
  confidence: number
  provenance?: Record<string, unknown> | null
}

export type InitialEvidenceInput = Omit<AddEvidenceInput, "claimId">

/**
 * Creates a claim and optionally adds initial evidence.
 * Recomputes aggregated confidence from all evidence.
 * Validates predicate against schema (CoreRelType, ExtensionRelType, or allowed ingestion predicates).
 */
export async function createClaim(
  input: CreateClaimInput,
  initialEvidence?: InitialEvidenceInput,
): Promise<string> {
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

  const claimId = generateObjectId("claim")
  const now = new Date()
  const db = getOrgDb()
  const resolvedOrgId = requireCurrentOrgId()

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

  return claimId
}

/**
 * Adds evidence to an existing claim and recomputes aggregated confidence.
 */
export async function addEvidence(input: AddEvidenceInput): Promise<string> {
  const evId = generateObjectId("ev")
  const now = new Date()
  const db = getOrgDb()

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

  return evId
}
