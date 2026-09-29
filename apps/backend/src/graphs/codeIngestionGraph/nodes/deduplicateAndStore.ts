import { and, eq, inArray, or } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { type Db, withOrgDbContext } from "../../../db/client.js"
import { claimEvidence } from "../../../db/schema/claim_evidence.js"
import { claims } from "../../../db/schema/claims.js"
import { objects } from "../../../db/schema/objects.js"
import { generateObjectId } from "../../../lib/id.js"
import { flushWorkflowLog, getLogger } from "../../../observability/logger.js"
import type {
  ExtractionMethod,
  SourceType,
} from "../../../retrieval/schema/claims.js"
import {
  type AddEvidenceInput,
  addEvidenceBulk,
  type BulkCreateClaimWithEvidenceItem,
  createClaimsWithEvidenceBulk,
  type TouchEvidenceInput,
  touchEvidenceBulk,
} from "../../../retrieval/services/claimWrite.js"
import { aggregateConfidence } from "../../../retrieval/services/confidenceAggregation.js"
import { evidenceSourceIdMayHaveWindowsDriveColon } from "../../../retrieval/services/ingestionPathMatching.js"
import { deriveLogicalSourceKey } from "../../../retrieval/services/logicalSourceKey.js"
import { batchUpsertRetrievalObjectsByDeduplicationKey } from "../../../retrieval/services/retrievalObjectWrite.js"
import type { ClaimForProjection, CodeIngestionState } from "../schemas.js"
import { isIdRef } from "../schemas.js"
import { setIngestionIndexingStep } from "../setIngestionIndexingStep.js"

/** Chunk size for IN-list claim/evidence prefetch. */
export const DEDUP_CLAIM_PREFETCH_BATCH_SIZE = 500
/**
 * Triple-match batch. 500 × 3 equals + org stays far under Postgres's
 * 65535 bind cap, and is 5× fewer round-trips than the old 100-triple OR.
 */
export const DEDUP_CLAIM_TRIPLE_BATCH_SIZE = 500
/** Emit progress evlog + flush every N claims processed (and after object chunks). */
export const DEDUP_PROGRESS_EVERY_CLAIMS = 250

/** True when `processed` hits a progress boundary (and is non-zero). */
export function shouldEmitDedupProgress(
  processed: number,
  every: number = DEDUP_PROGRESS_EVERY_CLAIMS,
): boolean {
  return every > 0 && processed > 0 && processed % every === 0
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export function claimTripleKey(
  subjectId: string,
  predicate: string,
  objectId: string,
): string {
  return `${subjectId}\0${predicate}\0${objectId}`
}

/**
 * JS equivalent of the SQL duplicate-evidence OR used previously in
 * {@link deduplicateAndStore}: logical key match, exact sourceId, or derived
 * key from a legacy null logical_source_key row.
 */
export function claimEvidenceMatchesLogicalKey(
  evidence: { sourceId: string; logicalSourceKey: string | null },
  logicalKey: string,
  sourceId: string,
  targetHash: string,
): boolean {
  if (evidence.logicalSourceKey === logicalKey) return true
  if (evidence.sourceId === sourceId) return true
  if (
    evidence.logicalSourceKey == null &&
    deriveLogicalSourceKey(evidence.sourceId, targetHash) === logicalKey
  ) {
    return true
  }
  return false
}

/**
 * Resolves a subject/object ref: stable object ids pass through; deduplication keys
 * resolve via `keyToId` (batch upserts) or a Postgres lookup on `objects.deduplication_key`.
 * The DB lookup runs on demand so parallel per-root ingestion branches can reference `svc:…` keys
 * for services upserted in another branch (after commit) or from prior runs.
 */
export async function resolveDedupRefToId(
  ref: string,
  keyToId: Map<string, string>,
  orgId: string,
  db: Db,
): Promise<string | null> {
  if (isIdRef(ref)) return ref
  const cached = keyToId.get(ref)
  if (cached) return cached
  const row = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.deduplicationKey, ref)))
    .limit(1)
  if (row[0]) {
    keyToId.set(ref, row[0].id)
    return row[0].id
  }
  return null
}

/** Batch-fill `keyToId` for missing non-id deduplication keys (chunked IN). */
export async function prefetchDedupKeysIntoMap(
  refs: Iterable<string>,
  keyToId: Map<string, string>,
  orgId: string,
  db: Db,
): Promise<void> {
  const missing = [
    ...new Set([...refs].filter((ref) => !isIdRef(ref) && !keyToId.has(ref))),
  ]
  for (const chunk of chunkArray(missing, DEDUP_CLAIM_PREFETCH_BATCH_SIZE)) {
    const rows = await db
      .select({
        id: objects.id,
        deduplicationKey: objects.deduplicationKey,
      })
      .from(objects)
      .where(
        and(eq(objects.orgId, orgId), inArray(objects.deduplicationKey, chunk)),
      )
    for (const row of rows) {
      if (row.deduplicationKey) {
        keyToId.set(row.deduplicationKey, row.id)
      }
    }
  }
}

function resolveRefFromMap(
  ref: string,
  keyToId: Map<string, string>,
): string | null {
  if (isIdRef(ref)) return ref
  return keyToId.get(ref) ?? null
}

export type PrefetchedClaim = {
  id: string
  subjectId: string
  objectId: string
  predicate: string
  status: string
  aggregatedConfidence: number
  lastObservedAt: Date
  validFrom: Date | null
  validTo: Date | null
}

type SourceTypeValue = (typeof SourceType)["_output"]
type ExtractionMethodValue = (typeof ExtractionMethod)["_output"]

type PrefetchedEvidence = {
  /** Row id for evidence already in Postgres; null for rows written by this run. */
  id: string | null
  sourceId: string
  logicalSourceKey: string | null
  sourceType: SourceTypeValue
  extractionMethod: ExtractionMethodValue
  confidence: number
  observedAt: Date
}

function isoDateOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function projectionFromPrefetch(
  row: PrefetchedClaim,
  kinds: { subjectKind: string; objectKind: string },
  sourceCount: number,
  lastObservedAt: string,
  aggregatedConfidence: number,
): ClaimForProjection {
  return {
    id: row.id,
    subjectId: row.subjectId,
    objectId: row.objectId,
    subjectKind: kinds.subjectKind,
    objectKind: kinds.objectKind,
    predicate: row.predicate,
    status: row.status,
    aggregatedConfidence,
    sourceCount,
    lastObservedAt,
    validFrom: isoDateOrNull(row.validFrom),
    validTo: isoDateOrNull(row.validTo),
  }
}

function confidenceFromEvidence(list: PrefetchedEvidence[]): number {
  return aggregateConfidence(
    list.map((e) => ({
      sourceType: e.sourceType,
      extractionMethod: e.extractionMethod,
      confidence: e.confidence,
      observedAt: e.observedAt,
    })),
  )
}

/**
 * Load existing claims for unique subject/predicate/object triples.
 * Returns full projection fields so the store step never refetches by id.
 */
export async function prefetchClaimsByTriples(
  orgId: string,
  db: Db,
  triples: Array<{ subjectId: string; predicate: string; objectId: string }>,
): Promise<Map<string, PrefetchedClaim>> {
  const byTriple = new Map<string, PrefetchedClaim>()
  for (const chunk of chunkArray(triples, DEDUP_CLAIM_TRIPLE_BATCH_SIZE)) {
    const condition = or(
      ...chunk.map((t) =>
        and(
          eq(claims.subjectId, t.subjectId),
          eq(claims.predicate, t.predicate),
          eq(claims.objectId, t.objectId),
        ),
      ),
    )
    if (!condition) continue
    const rows = await db
      .select({
        id: claims.id,
        subjectId: claims.subjectId,
        predicate: claims.predicate,
        objectId: claims.objectId,
        status: claims.status,
        aggregatedConfidence: claims.aggregatedConfidence,
        lastObservedAt: claims.lastObservedAt,
        validFrom: claims.validFrom,
        validTo: claims.validTo,
      })
      .from(claims)
      .where(and(eq(claims.orgId, orgId), condition))
    for (const row of rows) {
      byTriple.set(claimTripleKey(row.subjectId, row.predicate, row.objectId), {
        ...row,
      })
    }
  }
  return byTriple
}

export async function prefetchEvidenceByClaimIds(
  db: Db,
  claimIds: string[],
): Promise<Map<string, PrefetchedEvidence[]>> {
  const byClaim = new Map<string, PrefetchedEvidence[]>()
  const uniqueIds = [...new Set(claimIds)]
  for (const chunk of chunkArray(uniqueIds, DEDUP_CLAIM_PREFETCH_BATCH_SIZE)) {
    const rows = await db
      .select({
        id: claimEvidence.id,
        claimId: claimEvidence.claimId,
        sourceId: claimEvidence.sourceId,
        logicalSourceKey: claimEvidence.logicalSourceKey,
        sourceType: claimEvidence.sourceType,
        extractionMethod: claimEvidence.extractionMethod,
        confidence: claimEvidence.confidence,
        observedAt: claimEvidence.observedAt,
      })
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, chunk))
    for (const row of rows) {
      const list = byClaim.get(row.claimId) ?? []
      list.push({
        id: row.id,
        sourceId: row.sourceId,
        logicalSourceKey: row.logicalSourceKey,
        sourceType: row.sourceType as SourceTypeValue,
        extractionMethod: row.extractionMethod as ExtractionMethodValue,
        confidence: row.confidence,
        observedAt: row.observedAt,
      })
      byClaim.set(row.claimId, list)
    }
  }
  return byClaim
}

/**
 * Deduplicate extracted objects/claims into Postgres.
 *
 * Uses short `withOrgDbContext` scopes per phase/chunk (object upserts open
 * their own per-chunk txs) — never one multi-minute transaction holding a
 * pool client for the whole kubernetes-scale run.
 *
 * Claims are projected from the prefetch + in-memory classify loop. There is
 * no end-of-run `IN (claim_id…)` refetch, which overflowed Postgres at n8n
 * scale (97k binds vs a 65535 cap).
 */
export async function deduplicateAndStore(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  await setIngestionIndexingStep(state, "deduplicating")
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
  const { extractedObjects = [], extractedClaims = [] } = state
  const { targetHash } = state
  const dedupStartedAt = Date.now()

  const emitProgress = (fields: Record<string, unknown>) => {
    logger.set({
      step: "codeIngestion.deduplicateAndStore.progress",
      repositoryId: state.repositoryId,
      orgId: state.orgId,
      roots: state.roots,
      elapsedMs: Date.now() - dedupStartedAt,
      extractedObjectsCount: extractedObjects.length,
      extractedClaimsCount: extractedClaims.length,
      ...fields,
    })
    logger.info("deduplicateAndStore progress")
    flushWorkflowLog()
  }

  const objectIds: string[] = []
  const touchedObjectIds: string[] = []
  const projectionById = new Map<string, ClaimForProjection>()
  const keyToId = new Map<string, string>()
  let claimsDuplicateEvidenceSkipped = 0
  let claimsNewCreated = 0
  let claimsEvidenceAddedToExisting = 0
  let claimsSkippedUnresolvedRef = 0
  let warnedWindowsDriveColonInSourceId = false

  const sortedObjects = [...extractedObjects].sort((a, b) => {
    const aStub =
      typeof a.payload === "object" &&
      a.payload !== null &&
      (a.payload as Record<string, unknown>).inferredFromConsumer === true
    const bStub =
      typeof b.payload === "object" &&
      b.payload !== null &&
      (b.payload as Record<string, unknown>).inferredFromConsumer === true
    if (aStub === bStub) return 0
    return aStub ? 1 : -1
  })

  const upsertInputs = sortedObjects.map((obj) => ({
    kind: obj.kind as string,
    deduplicationKey: obj.deduplicationKey,
    payload: {
      name: obj.name,
      summary: obj.summary,
      ...(typeof obj.payload === "object" && obj.payload !== null
        ? obj.payload
        : {}),
    } as Record<string, unknown>,
  }))
  // Per-chunk txs inside batchUpsertRetrievalObjectsByDeduplicationKey.
  const upsertResults = await batchUpsertRetrievalObjectsByDeduplicationKey(
    orgId,
    upsertInputs,
    {
      onChunk: ({ processedUniqueKeys, totalUniqueKeys }) => {
        emitProgress({
          phase: "objects",
          objectsProcessedUniqueKeys: processedUniqueKeys,
          objectsTotalUniqueKeys: totalUniqueKeys,
          objectsInputCount: sortedObjects.length,
        })
      },
    },
  )
  for (const obj of sortedObjects) {
    const result = upsertResults.get(obj.deduplicationKey)
    if (!result) continue
    keyToId.set(obj.deduplicationKey, result.id)
    objectIds.push(result.id)
    if (result.needsEmbeddingRefresh) {
      touchedObjectIds.push(result.id)
    }
  }

  const now = new Date()
  const nowIso = now.toISOString()

  await withOrgDbContext(orgId, async (db) => {
    await prefetchDedupKeysIntoMap(
      extractedClaims.flatMap((c) => [c.subjectRef, c.objectRef]),
      keyToId,
      orgId,
      db,
    )
  })

  const uniqueTriples: Array<{
    subjectId: string
    predicate: string
    objectId: string
  }> = []
  const seenTriples = new Set<string>()
  let claimsResolvedCount = 0

  for (const c of extractedClaims) {
    const subjectId = resolveRefFromMap(c.subjectRef, keyToId)
    const objectId = resolveRefFromMap(c.objectRef, keyToId)
    if (!subjectId || !objectId) continue
    claimsResolvedCount++
    const key = claimTripleKey(subjectId, c.predicate, objectId)
    if (seenTriples.has(key)) continue
    seenTriples.add(key)
    uniqueTriples.push({
      subjectId,
      predicate: c.predicate,
      objectId,
    })
  }

  const claimsById = new Map<string, PrefetchedClaim>()
  const claimIdByTriple = new Map<string, string>()
  let evidenceByClaimId = new Map<string, PrefetchedEvidence[]>()
  const triplePrefetchQueries = Math.ceil(
    uniqueTriples.length / DEDUP_CLAIM_TRIPLE_BATCH_SIZE,
  )

  if (uniqueTriples.length > 0) {
    const prefetched = await withOrgDbContext(orgId, async (db) => {
      const byTriple = await prefetchClaimsByTriples(orgId, db, uniqueTriples)
      const byClaim = await prefetchEvidenceByClaimIds(
        db,
        [...byTriple.values()].map((row) => row.id),
      )
      return { byTriple, byClaim }
    })
    for (const [triple, row] of prefetched.byTriple) {
      claimsById.set(row.id, row)
      claimIdByTriple.set(triple, row.id)
    }
    evidenceByClaimId = prefetched.byClaim
  }

  if (claimsResolvedCount > 0) {
    emitProgress({
      phase: "claims_prefetch",
      claimsResolvedCount,
      claimsUniqueTriples: uniqueTriples.length,
      claimsExistingPrefetched: claimsById.size,
      claimsTriplePrefetchQueries: triplePrefetchQueries,
    })
  }

  const newClaimWrites: BulkCreateClaimWithEvidenceItem[] = []
  const addEvidenceWrites: AddEvidenceInput[] = []
  const evidenceTouchWrites: TouchEvidenceInput[] = []

  const logUnresolved = (
    reason: "unresolved_subject_ref" | "unresolved_object_ref",
    c: (typeof extractedClaims)[number],
  ) => {
    claimsSkippedUnresolvedRef++
    logger.set({
      step: "codeIngestion.deduplicateAndStore.claimSkipped",
      reason,
      repositoryId: state.repositoryId,
      orgId,
      roots: state.roots,
      predicate: c.predicate,
      subjectRef: c.subjectRef,
      objectRef: c.objectRef,
      sourceId: c.sourceId,
    })
    logger.warn(
      reason === "unresolved_subject_ref"
        ? "[codeIngestion] skipping claim: unresolved subject deduplication ref"
        : "[codeIngestion] skipping claim: unresolved object deduplication ref",
      {
        repositoryId: state.repositoryId,
        predicate: c.predicate,
        subjectRef: c.subjectRef,
        objectRef: c.objectRef,
        sourceId: c.sourceId,
      },
    )
  }

  let claimsProcessed = 0
  for (const c of extractedClaims) {
    const subjectId = resolveRefFromMap(c.subjectRef, keyToId)
    if (!subjectId) {
      logUnresolved("unresolved_subject_ref", c)
      continue
    }
    const objectId = resolveRefFromMap(c.objectRef, keyToId)
    if (!objectId) {
      logUnresolved("unresolved_object_ref", c)
      continue
    }

    const subjectKind = c.subjectKind
    const objectKind = c.objectKind
    const logicalKey = deriveLogicalSourceKey(c.sourceId, targetHash)
    const kinds = { subjectKind, objectKind }

    if (
      !warnedWindowsDriveColonInSourceId &&
      evidenceSourceIdMayHaveWindowsDriveColon(c.sourceId)
    ) {
      warnedWindowsDriveColonInSourceId = true
      logger.warn(
        "deduplicateAndStore: source_id may contain a Windows drive colon; colon-delimited evidence keys can be ambiguous",
        {
          repositoryId: state.repositoryId,
          orgId,
          sourceId: c.sourceId,
        },
      )
    }

    const triple = claimTripleKey(subjectId, c.predicate, objectId)
    const existingClaimId = claimIdByTriple.get(triple)
    const existingEvidence = existingClaimId
      ? (evidenceByClaimId.get(existingClaimId) ?? [])
      : []

    const matchedEvidence = existingClaimId
      ? existingEvidence.find((ev) =>
          claimEvidenceMatchesLogicalKey(
            ev,
            logicalKey,
            c.sourceId,
            targetHash,
          ),
        )
      : undefined

    if (existingClaimId && matchedEvidence) {
      claimsDuplicateEvidenceSkipped++
      if (matchedEvidence.id) {
        evidenceTouchWrites.push({
          id: matchedEvidence.id,
          claimId: existingClaimId,
          sourceId: c.sourceId,
          logicalSourceKey: logicalKey,
        })
        matchedEvidence.sourceId = c.sourceId
        matchedEvidence.logicalSourceKey = logicalKey
        matchedEvidence.observedAt = now
      }
      const row = claimsById.get(existingClaimId)
      if (row) {
        row.lastObservedAt = now
        projectionById.set(
          existingClaimId,
          projectionFromPrefetch(
            row,
            kinds,
            existingEvidence.length,
            nowIso,
            row.aggregatedConfidence,
          ),
        )
      }
      claimsProcessed++
      if (shouldEmitDedupProgress(claimsProcessed)) {
        emitProgress({
          phase: "claims",
          claimsProcessed,
          claimsTotal: claimsResolvedCount,
          claimsNewCreated,
          claimsEvidenceAddedToExisting,
          claimsDuplicateEvidenceSkipped,
          claimsSkippedUnresolvedRef,
        })
      }
      continue
    }

    if (existingClaimId) {
      claimsEvidenceAddedToExisting++
      addEvidenceWrites.push({
        claimId: existingClaimId,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        logicalSourceKey: logicalKey,
        extractionMethod: c.extractionMethod,
        confidence: c.confidence,
        provenance: c.provenance ?? null,
      })
      const list = evidenceByClaimId.get(existingClaimId) ?? []
      list.push({
        id: null,
        sourceId: c.sourceId,
        logicalSourceKey: logicalKey,
        sourceType: c.sourceType,
        extractionMethod: c.extractionMethod,
        confidence: c.confidence,
        observedAt: now,
      })
      evidenceByClaimId.set(existingClaimId, list)
      const row = claimsById.get(existingClaimId)
      if (row) {
        const agg = confidenceFromEvidence(list)
        row.aggregatedConfidence = agg
        row.lastObservedAt = now
        projectionById.set(
          existingClaimId,
          projectionFromPrefetch(row, kinds, list.length, nowIso, agg),
        )
      }
    } else {
      claimsNewCreated++
      const claimId = generateObjectId("claim")
      const validFrom = c.validFrom ? new Date(c.validFrom) : null
      const validTo = c.validTo ? new Date(c.validTo) : null
      newClaimWrites.push({
        claimId,
        claim: {
          subjectId,
          predicate: c.predicate,
          objectId,
          subjectKind,
          objectKind,
          validFrom,
          validTo,
        },
        evidence: {
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          logicalSourceKey: logicalKey,
          extractionMethod: c.extractionMethod,
          confidence: c.confidence,
          provenance: c.provenance ?? null,
        },
      })
      const evidence: PrefetchedEvidence[] = [
        {
          id: null,
          sourceId: c.sourceId,
          logicalSourceKey: logicalKey,
          sourceType: c.sourceType,
          extractionMethod: c.extractionMethod,
          confidence: c.confidence,
          observedAt: now,
        },
      ]
      const agg = confidenceFromEvidence(evidence)
      const row: PrefetchedClaim = {
        id: claimId,
        subjectId,
        objectId,
        predicate: c.predicate,
        status: "active",
        aggregatedConfidence: agg,
        lastObservedAt: now,
        validFrom,
        validTo,
      }
      claimsById.set(claimId, row)
      claimIdByTriple.set(triple, claimId)
      evidenceByClaimId.set(claimId, evidence)
      projectionById.set(claimId, {
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
        validFrom: c.validFrom ?? null,
        validTo: c.validTo ?? null,
      })
    }

    claimsProcessed++
    if (shouldEmitDedupProgress(claimsProcessed)) {
      emitProgress({
        phase: "claims",
        claimsProcessed,
        claimsTotal: claimsResolvedCount,
        claimsNewCreated,
        claimsEvidenceAddedToExisting,
        claimsDuplicateEvidenceSkipped,
        claimsSkippedUnresolvedRef,
      })
    }
  }

  await withOrgDbContext(orgId, async () => {
    await createClaimsWithEvidenceBulk(newClaimWrites)
    await addEvidenceBulk(addEvidenceWrites)
    await touchEvidenceBulk(evidenceTouchWrites, now)
  })

  const claimsForProjection = [...projectionById.values()]
  const uniqueObjectIds = [...new Set(objectIds)]
  const uniqueTouchedObjectIds = [...new Set(touchedObjectIds)]
  logger.set({
    step: "codeIngestion.deduplicateAndStore.summary",
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    roots: state.roots,
    extractedObjectsCount: extractedObjects.length,
    extractedClaimsCount: extractedClaims.length,
    objectsUpsertedCount: uniqueObjectIds.length,
    claimsObserved: extractedClaims.length,
    claimsNewCreated,
    claimsEvidenceAddedToExisting,
    claimsDuplicateEvidenceSkipped,
    claimsEvidenceTouched: evidenceTouchWrites.length,
    claimsSkippedUnresolvedRef,
    claimsForProjectionCount: claimsForProjection.length,
    claimsUniqueTriples: uniqueTriples.length,
    claimsTriplePrefetchQueries: triplePrefetchQueries,
    claimsRefetchQueries: 0,
  })
  logger.info("deduplicateAndStore summary")

  return {
    objectIds: uniqueObjectIds,
    touchedObjectIds: uniqueTouchedObjectIds,
    claimsForProjection,
  }
}
