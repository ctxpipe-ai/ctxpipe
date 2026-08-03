import { and, eq, inArray, or, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { type Db, getOrgDb } from "../../../db/client.js"
import { claimEvidence } from "../../../db/schema/claim_evidence.js"
import { claims } from "../../../db/schema/claims.js"
import { objects } from "../../../db/schema/objects.js"
import { getLogger } from "../../../observability/logger.js"
import {
  addEvidence,
  createClaim,
} from "../../../retrieval/services/claimWrite.js"
import { aggregateConfidence } from "../../../retrieval/services/confidenceAggregation.js"
import { evidenceSourceIdMayHaveWindowsDriveColon } from "../../../retrieval/services/ingestionPathMatching.js"
import { deriveLogicalSourceKey } from "../../../retrieval/services/logicalSourceKey.js"
import { batchUpsertRetrievalObjectsByDeduplicationKey } from "../../../retrieval/services/retrievalObjectWrite.js"
import type { ClaimForProjection, CodeIngestionState } from "../schemas.js"
import { isIdRef } from "../schemas.js"
import { withNodeOrgDbContext } from "../withNodeOrgDbContext.js"
import { setIngestionIndexingStep } from "../setIngestionIndexingStep.js"

/** Chunk size for IN-list / OR-triple claim prefetch. */
const DEDUP_CLAIM_PREFETCH_BATCH_SIZE = 500
const DEDUP_CLAIM_TRIPLE_BATCH_SIZE = 100

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
    ...new Set(
      [...refs].filter((ref) => !isIdRef(ref) && !keyToId.has(ref)),
    ),
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

type PrefetchedEvidence = {
  sourceId: string
  logicalSourceKey: string | null
}

async function prefetchClaimsByTriples(
  orgId: string,
  db: Db,
  triples: Array<{ subjectId: string; predicate: string; objectId: string }>,
): Promise<Map<string, string>> {
  const claimByTriple = new Map<string, string>()
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
      })
      .from(claims)
      .where(and(eq(claims.orgId, orgId), condition))
    for (const row of rows) {
      claimByTriple.set(
        claimTripleKey(row.subjectId, row.predicate, row.objectId),
        row.id,
      )
    }
  }
  return claimByTriple
}

async function prefetchEvidenceByClaimIds(
  db: Db,
  claimIds: string[],
): Promise<Map<string, PrefetchedEvidence[]>> {
  const byClaim = new Map<string, PrefetchedEvidence[]>()
  for (const chunk of chunkArray(claimIds, DEDUP_CLAIM_PREFETCH_BATCH_SIZE)) {
    const rows = await db
      .select({
        claimId: claimEvidence.claimId,
        sourceId: claimEvidence.sourceId,
        logicalSourceKey: claimEvidence.logicalSourceKey,
      })
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, chunk))
    for (const row of rows) {
      const list = byClaim.get(row.claimId) ?? []
      list.push({
        sourceId: row.sourceId,
        logicalSourceKey: row.logicalSourceKey,
      })
      byClaim.set(row.claimId, list)
    }
  }
  return byClaim
}

export const deduplicateAndStore = withNodeOrgDbContext(
  async (state: CodeIngestionState): Promise<Partial<CodeIngestionState>> => {
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
    const db = getOrgDb()
    const { extractedObjects = [], extractedClaims = [] } = state
    const { targetHash } = state

    const objectIds: string[] = []
    const touchedObjectIds: string[] = []
    const claimsForProjection: ClaimForProjection[] = []
    const claimIdsToFetch: string[] = []
    const claimIdToKinds = new Map<
      string,
      { subjectKind: string; objectKind: string }
    >()
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
    const upsertResults = await batchUpsertRetrievalObjectsByDeduplicationKey(
      orgId,
      upsertInputs,
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

    await prefetchDedupKeysIntoMap(
      extractedClaims.flatMap((c) => [c.subjectRef, c.objectRef]),
      keyToId,
      orgId,
      db,
    )

    type ResolvedClaim = (typeof extractedClaims)[number] & {
      subjectId: string
      objectId: string
      logicalKey: string
    }
    const resolvedClaims: ResolvedClaim[] = []

    for (const c of extractedClaims) {
      const subjectId = resolveRefFromMap(c.subjectRef, keyToId)
      if (!subjectId) {
        claimsSkippedUnresolvedRef++
        logger.set({
          step: "codeIngestion.deduplicateAndStore.claimSkipped",
          reason: "unresolved_subject_ref",
          repositoryId: state.repositoryId,
          orgId,
          roots: state.roots,
          predicate: c.predicate,
          subjectRef: c.subjectRef,
          objectRef: c.objectRef,
          sourceId: c.sourceId,
        })
        logger.warn(
          "[codeIngestion] skipping claim: unresolved subject deduplication ref",
          {
            repositoryId: state.repositoryId,
            predicate: c.predicate,
            subjectRef: c.subjectRef,
            objectRef: c.objectRef,
            sourceId: c.sourceId,
          },
        )
        continue
      }

      const objectId = resolveRefFromMap(c.objectRef, keyToId)
      if (!objectId) {
        claimsSkippedUnresolvedRef++
        logger.set({
          step: "codeIngestion.deduplicateAndStore.claimSkipped",
          reason: "unresolved_object_ref",
          repositoryId: state.repositoryId,
          orgId,
          roots: state.roots,
          predicate: c.predicate,
          subjectRef: c.subjectRef,
          objectRef: c.objectRef,
          sourceId: c.sourceId,
        })
        logger.warn(
          "[codeIngestion] skipping claim: unresolved object deduplication ref",
          {
            repositoryId: state.repositoryId,
            predicate: c.predicate,
            subjectRef: c.subjectRef,
            objectRef: c.objectRef,
            sourceId: c.sourceId,
          },
        )
        continue
      }

      resolvedClaims.push({
        ...c,
        subjectId,
        objectId,
        logicalKey: deriveLogicalSourceKey(c.sourceId, targetHash),
      })
    }

    const uniqueTriples: Array<{
      subjectId: string
      predicate: string
      objectId: string
    }> = []
    const seenTriples = new Set<string>()
    for (const c of resolvedClaims) {
      const key = claimTripleKey(c.subjectId, c.predicate, c.objectId)
      if (seenTriples.has(key)) continue
      seenTriples.add(key)
      uniqueTriples.push({
        subjectId: c.subjectId,
        predicate: c.predicate,
        objectId: c.objectId,
      })
    }

    const claimByTriple = await prefetchClaimsByTriples(
      orgId,
      db,
      uniqueTriples,
    )
    const evidenceByClaimId = await prefetchEvidenceByClaimIds(db, [
      ...claimByTriple.values(),
    ])

    for (const c of resolvedClaims) {
      const subjectKind = c.subjectKind
      const objectKind = c.objectKind
      const logicalKey = c.logicalKey

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

      const triple = claimTripleKey(c.subjectId, c.predicate, c.objectId)
      const existingClaimId = claimByTriple.get(triple)
      const existingEvidence = existingClaimId
        ? (evidenceByClaimId.get(existingClaimId) ?? [])
        : []

      // Duplicate evidence: skip DB writes, but still queue projection so the graph
      // stays in sync (e.g. first projection failed, graph was wiped, or dev DB restored).
      if (
        existingClaimId &&
        existingEvidence.some((ev) =>
          claimEvidenceMatchesLogicalKey(
            ev,
            logicalKey,
            c.sourceId,
            targetHash,
          ),
        )
      ) {
        claimsDuplicateEvidenceSkipped++
        claimIdsToFetch.push(existingClaimId)
        claimIdToKinds.set(existingClaimId, { subjectKind, objectKind })
        continue
      }

      if (existingClaimId) {
        claimsEvidenceAddedToExisting++
        await addEvidence({
          claimId: existingClaimId,
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          logicalSourceKey: logicalKey,
          extractionMethod: c.extractionMethod,
          confidence: c.confidence,
          provenance: c.provenance ?? null,
        })
        const list = evidenceByClaimId.get(existingClaimId) ?? []
        list.push({ sourceId: c.sourceId, logicalSourceKey: logicalKey })
        evidenceByClaimId.set(existingClaimId, list)
        claimIdsToFetch.push(existingClaimId)
        claimIdToKinds.set(existingClaimId, {
          subjectKind,
          objectKind,
        })
      } else {
        claimsNewCreated++
        const claimId = await createClaim(
          {
            subjectId: c.subjectId,
            predicate: c.predicate,
            objectId: c.objectId,
            subjectKind,
            objectKind,
          },
          {
            sourceType: c.sourceType,
            sourceId: c.sourceId,
            logicalSourceKey: logicalKey,
            extractionMethod: c.extractionMethod,
            confidence: c.confidence,
            provenance: c.provenance ?? null,
          },
        )
        claimByTriple.set(triple, claimId)
        evidenceByClaimId.set(claimId, [
          { sourceId: c.sourceId, logicalSourceKey: logicalKey },
        ])
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
          subjectId: c.subjectId,
          objectId: c.objectId,
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
        .where(
          and(eq(claims.orgId, orgId), inArray(claims.id, claimIdsToFetch)),
        )

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
      claimsSkippedUnresolvedRef,
      claimsForProjectionCount: claimsForProjection.length,
    })
    logger.info("deduplicateAndStore summary")

    return {
      objectIds: uniqueObjectIds,
      touchedObjectIds: uniqueTouchedObjectIds,
      claimsForProjection,
    }
  },
)
