import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm"
import type { z } from "zod/v3"
import type { Db } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { log } from "../../observability/logger.js"
import type { ExtractionMethod, SourceType } from "../schema/claims.js"
import { aggregateConfidence } from "./confidenceAggregation.js"
import {
  deleteObjectsFromGraph,
  refreshClaimProjections,
  retractClaimsFromGraph,
} from "./graphProjection.js"
import { escapeRegex, normalizeGitPath } from "./ingestionPathMatching.js"

/** Keep deletes under Postgres parameter limits and log progress on large purges. */
const EVIDENCE_DELETE_CHUNK_SIZE = 500

type SourceTypeValue = z.infer<typeof SourceType>
type ExtractionMethodValue = z.infer<typeof ExtractionMethod>

/**
 * Counters for partial-ingest retraction. Evidence/claim/orphan-object mutations are
 * recorded inside {@link retractIngestionForDiffPg} (Postgres transaction). Graph-side
 * deletes/refreshes run later via {@link applyIngestionRetractionGraphEffects} (Falkor);
 * `graph*` fields stay 0 until that step merges them into this snapshot.
 */
export type RetractionStats = {
  /** Postgres: `claim_evidence` rows updated for path renames (within the PG transaction). */
  renamedEvidenceRows: number
  /** Postgres: `claim_evidence` rows deleted for changed/removed paths (within the PG transaction). */
  deletedEvidenceRows: number
  /** Postgres: claims reconciled (aggregate refresh) after evidence changes. */
  claimsUpdated: number
  /** Postgres: claims deleted after all evidence for a claim was removed. */
  claimsDeleted: number
  /** Postgres: `objects` rows removed after orphan claim deletion (within the PG transaction). */
  orphanObjectsDeleted: number
  /**
   * Falkor: claim edges removed by {@link applyIngestionRetractionGraphEffects}. Filled when
   * the workflow merges that step's return value into stats; 0 before graph sync.
   */
  graphEdgesDeleted: number
  /**
   * Falkor: claim projections refreshed after evidence updates. Filled after graph sync;
   * 0 in {@link retractIngestionForDiffPg} results until merged.
   */
  graphClaimsRefreshed: number
  /**
   * Falkor: orphan object nodes deleted after Postgres orphan removal. Filled after graph
   * sync; 0 before merge.
   */
  graphOrphanObjectsDeleted: number
}

export type IngestionRetractionGraphEffects = {
  deletedClaimIds: string[]
  refreshedClaimIds: string[]
  /** Object ids removed in Postgres; Falkor nodes deleted in the graph sync step. */
  deletedObjectIds: string[]
}

function emptyStats(): RetractionStats {
  return {
    renamedEvidenceRows: 0,
    deletedEvidenceRows: 0,
    claimsUpdated: 0,
    claimsDeleted: 0,
    orphanObjectsDeleted: 0,
    graphEdgesDeleted: 0,
    graphClaimsRefreshed: 0,
    graphOrphanObjectsDeleted: 0,
  }
}

/** Matches extractor keys like `identifyAPIs:repo_1:…` without LIKE wildcards. */
function repositoryIdNeedle(repositoryId: string): string {
  return `:${repositoryId}:`
}

function repoEvidenceFilter(repositoryId: string) {
  const needle = repositoryIdNeedle(repositoryId)
  return or(
    sql`strpos(${claimEvidence.logicalSourceKey}::text, ${needle}) > 0`,
    sql`strpos(${claimEvidence.sourceId}::text, ${needle}) > 0`,
  )
}

function pathSegmentRegexPattern(normalizedPath: string): string {
  const p = normalizeGitPath(normalizedPath)
  return `(^|:)${escapeRegex(p)}(:|$)`
}

async function reconcileClaimAfterEvidenceChange(
  tx: Db,
  orgId: string,
  claimId: string,
  now: Date,
): Promise<{ outcome: "deleted" | "updated"; orphanObjectIds: string[] }> {
  const allEvidence = await tx
    .select({
      sourceType: claimEvidence.sourceType,
      extractionMethod: claimEvidence.extractionMethod,
      confidence: claimEvidence.confidence,
      observedAt: claimEvidence.observedAt,
    })
    .from(claimEvidence)
    .where(eq(claimEvidence.claimId, claimId))

  if (allEvidence.length === 0) {
    const rows = await tx
      .select({
        subjectId: claims.subjectId,
        objectId: claims.objectId,
      })
      .from(claims)
      .where(and(eq(claims.id, claimId), eq(claims.orgId, orgId)))
      .limit(1)
    const row = rows[0]
    const orphanObjectIds: string[] = []
    await tx.delete(claims).where(eq(claims.id, claimId))
    if (row) {
      for (const oid of [row.subjectId, row.objectId]) {
        const [cntRow] = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(claims)
          .where(
            and(
              eq(claims.orgId, orgId),
              or(eq(claims.subjectId, oid), eq(claims.objectId, oid)),
            ),
          )
        const cnt = cntRow?.c ?? 0
        if (cnt === 0) {
          await tx
            .delete(objects)
            .where(and(eq(objects.orgId, orgId), eq(objects.id, oid)))
          orphanObjectIds.push(oid)
        }
      }
    }
    return { outcome: "deleted", orphanObjectIds }
  }

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
    .where(eq(claims.id, claimId))

  return { outcome: "updated", orphanObjectIds: [] }
}

/**
 * Falkor-only follow-up for {@link retractIngestionForDiffPg}. Call only after the org
 * Postgres transaction that performed evidence/claim updates has committed (e.g. from a
 * workflow step after `withOrgDbContext`). Workflows that track {@link RetractionStats}
 * should merge the returned counts into the same stats object (see repository-ingestion).
 */
export async function applyIngestionRetractionGraphEffects(
  effects: IngestionRetractionGraphEffects,
): Promise<{
  graphEdgesDeleted: number
  graphClaimsRefreshed: number
  graphOrphanObjectsDeleted: number
}> {
  const deletedClaimIds = [...new Set(effects.deletedClaimIds)]
  const refreshedClaimIds = [...new Set(effects.refreshedClaimIds)]
  const deletedObjectIds = [...new Set(effects.deletedObjectIds)]

  await retractClaimsFromGraph(deletedClaimIds)
  await refreshClaimProjections(refreshedClaimIds)
  await deleteObjectsFromGraph(deletedObjectIds)

  return {
    graphEdgesDeleted: deletedClaimIds.length,
    graphClaimsRefreshed: refreshedClaimIds.length,
    graphOrphanObjectsDeleted: deletedObjectIds.length,
  }
}

/**
 * Retracts stale evidence for a partial ingest diff: renames keys first, then deletes
 * evidence for changed/removed paths. Reconciles claim aggregates and drops orphan claims.
 * Graph sync is deferred — use {@link applyIngestionRetractionGraphEffects} after commit.
 *
 * No-op when `ingestMode !== "partial"` or when there are no changed/deleted paths or renames.
 *
 * Postgres mutations run in `db.transaction` (nested savepoint when already inside
 * `withOrgDbContext`).
 */
export async function retractIngestionForDiffPg(
  db: Db,
  params: {
    orgId: string
    repositoryId: string
    ingestMode: "partial" | "full"
    changedPaths: string[]
    deletedPaths: string[]
    renames: { from: string; to: string }[]
  },
): Promise<{
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
}> {
  const {
    orgId,
    repositoryId,
    ingestMode,
    changedPaths,
    deletedPaths,
    renames,
  } = params

  const hasDiff =
    (changedPaths?.length ?? 0) > 0 ||
    (deletedPaths?.length ?? 0) > 0 ||
    (renames?.length ?? 0) > 0
  if (ingestMode !== "partial" || !hasDiff) {
    return {
      stats: emptyStats(),
      graphEffects: {
        deletedClaimIds: [],
        refreshedClaimIds: [],
        deletedObjectIds: [],
      },
    }
  }

  const stats = emptyStats()
  const now = new Date()

  const affectedClaimIds = new Set<string>()
  let graphDeletedClaimIds: string[] = []
  let graphUpdatedClaimIds: string[] = []
  const deletedObjectIds = new Set<string>()

  const repoNeedle = repositoryIdNeedle(repositoryId)

  await db.transaction(async (tx) => {
    for (const r of renames) {
      const fromNorm = normalizeGitPath(r.from)
      const toNorm = normalizeGitPath(r.to)
      if (fromNorm.length === 0) continue
      const escapedFrom = escapeRegex(fromNorm)

      const res = await tx.execute(
        sql`
          UPDATE claim_evidence ce
          SET
            logical_source_key = CASE
              WHEN ce.logical_source_key IS NOT NULL THEN regexp_replace(
                ce.logical_source_key::text,
                '(^|:)(' || ${escapedFrom} || ')(:|$)',
                concat(
                  chr(92) || '1',
                  replace(replace(${toNorm}::text, chr(92), chr(92) || chr(92)), '&', chr(92) || '&'),
                  chr(92) || '3'
                ),
                'g'
              )
              ELSE NULL
            END,
            source_id = regexp_replace(
              ce.source_id::text,
              '(^|:)(' || ${escapedFrom} || ')(:|$)',
              concat(
                chr(92) || '1',
                replace(replace(${toNorm}::text, chr(92), chr(92) || chr(92)), '&', chr(92) || '&'),
                chr(92) || '3'
              ),
              'g'
            )
          FROM claims c
          WHERE ce.claim_id = c.id
            AND c.org_id = ${orgId}
            AND (
              strpos(ce.logical_source_key::text, ${repoNeedle}) > 0
              OR strpos(ce.source_id::text, ${repoNeedle}) > 0
            )
          RETURNING ce.id
        `,
      )
      const rows =
        (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])
      stats.renamedEvidenceRows += rows.length
    }

    const pathsToRetract = [...new Set([...changedPaths, ...deletedPaths])]

    for (const rawPath of pathsToRetract) {
      const pattern = pathSegmentRegexPattern(rawPath)
      const rows = await tx
        .select({
          id: claimEvidence.id,
          claimId: claimEvidence.claimId,
        })
        .from(claimEvidence)
        .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
        .where(
          and(
            eq(claims.orgId, orgId),
            repoEvidenceFilter(repositoryId),
            or(
              and(
                isNotNull(claimEvidence.logicalSourceKey),
                sql`${claimEvidence.logicalSourceKey}::text ~ ${pattern}`,
              ),
              sql`${claimEvidence.sourceId}::text ~ ${pattern}`,
            ),
          ),
        )

      if (rows.length === 0) continue

      const ids = rows.map((r) => r.id)
      for (const r of rows) {
        affectedClaimIds.add(r.claimId)
      }

      await tx.delete(claimEvidence).where(inArray(claimEvidence.id, ids))
      stats.deletedEvidenceRows += ids.length
    }

    const claimsToReconcile = [...affectedClaimIds]

    graphDeletedClaimIds = []
    graphUpdatedClaimIds = []

    for (const claimId of claimsToReconcile) {
      const { outcome, orphanObjectIds } =
        await reconcileClaimAfterEvidenceChange(tx, orgId, claimId, now)
      for (const oid of orphanObjectIds) {
        deletedObjectIds.add(oid)
      }
      if (outcome === "deleted") {
        stats.claimsDeleted++
        graphDeletedClaimIds.push(claimId)
      } else {
        stats.claimsUpdated++
        graphUpdatedClaimIds.push(claimId)
      }
    }
  })

  stats.orphanObjectsDeleted = deletedObjectIds.size

  return {
    stats,
    graphEffects: {
      deletedClaimIds: graphDeletedClaimIds,
      refreshedClaimIds: graphUpdatedClaimIds,
      deletedObjectIds: [...deletedObjectIds],
    },
  }
}

async function chunkedInArraySelect<T>(
  ids: string[],
  run: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += EVIDENCE_DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + EVIDENCE_DELETE_CHUNK_SIZE)
    if (chunk.length === 0) continue
    out.push(...(await run(chunk)))
  }
  return out
}

async function chunkedInArrayDelete(
  ids: string[],
  run: (chunk: string[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += EVIDENCE_DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + EVIDENCE_DELETE_CHUNK_SIZE)
    if (chunk.length === 0) continue
    await run(chunk)
  }
}

/**
 * Delete the given evidence rows, then reconcile their claims set-based: claims
 * left without evidence are deleted (objects no other claim references go with
 * them); claims that keep proofs from other sources get their aggregate refreshed.
 * Runs inside the caller's transaction; accumulates into `stats` / `deletedObjectIds`.
 */
async function retractEvidenceRowsInTx(
  tx: Db,
  params: {
    orgId: string
    rows: Array<{ id: string; claimId: string }>
    now: Date
    stats: RetractionStats
    deletedObjectIds: Set<string>
  },
): Promise<{ deletedClaimIds: string[]; updatedClaimIds: string[] }> {
  const { orgId, rows, now, stats, deletedObjectIds } = params
  const affectedClaimIds = new Set<string>()
  const evidenceIds = rows.map((r) => r.id)
  for (const r of rows) affectedClaimIds.add(r.claimId)
  const claimIds = [...affectedClaimIds]

  await chunkedInArrayDelete(evidenceIds, (chunk) =>
    tx.delete(claimEvidence).where(inArray(claimEvidence.id, chunk)),
  )
  stats.deletedEvidenceRows += evidenceIds.length

  // Remaining evidence = proofs from other sources (multi-source survivors).
  const remainingEvidence = await chunkedInArraySelect(claimIds, (chunk) =>
    tx
      .select({
        claimId: claimEvidence.claimId,
        sourceType: claimEvidence.sourceType,
        extractionMethod: claimEvidence.extractionMethod,
        confidence: claimEvidence.confidence,
        observedAt: claimEvidence.observedAt,
      })
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, chunk)),
  )

  const remainingByClaim = new Map<
    string,
    Array<{
      sourceType: string
      extractionMethod: string
      confidence: number
      observedAt: Date
    }>
  >()
  for (const row of remainingEvidence) {
    const list = remainingByClaim.get(row.claimId)
    if (list) list.push(row)
    else remainingByClaim.set(row.claimId, [row])
  }

  const fullyOwnedClaimIds = claimIds.filter(
    (id) => (remainingByClaim.get(id)?.length ?? 0) === 0,
  )
  const multiSourceClaimIds = claimIds.filter(
    (id) => (remainingByClaim.get(id)?.length ?? 0) > 0,
  )

  if (fullyOwnedClaimIds.length > 0) {
    const claimRows = await chunkedInArraySelect(fullyOwnedClaimIds, (chunk) =>
      tx
        .select({
          id: claims.id,
          subjectId: claims.subjectId,
          objectId: claims.objectId,
        })
        .from(claims)
        .where(and(eq(claims.orgId, orgId), inArray(claims.id, chunk))),
    )

    const candidateObjectIds = new Set<string>()
    for (const row of claimRows) {
      candidateObjectIds.add(row.subjectId)
      candidateObjectIds.add(row.objectId)
    }

    await chunkedInArrayDelete(fullyOwnedClaimIds, (chunk) =>
      tx
        .delete(claims)
        .where(and(eq(claims.orgId, orgId), inArray(claims.id, chunk))),
    )

    stats.claimsDeleted += fullyOwnedClaimIds.length

    const objectIdList = [...candidateObjectIds]
    if (objectIdList.length > 0) {
      // Set-based orphan cleanup: delete objects no longer referenced by any claim.
      const orphanRows = await chunkedInArraySelect(objectIdList, (chunk) =>
        tx
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(
              eq(objects.orgId, orgId),
              inArray(objects.id, chunk),
              sql`NOT EXISTS (
                SELECT 1 FROM ${claims}
                WHERE ${claims.orgId} = ${orgId}
                  AND (
                    ${claims.subjectId} = ${objects.id}
                    OR ${claims.objectId} = ${objects.id}
                  )
              )`,
            ),
          ),
      )
      const orphanIds = orphanRows.map((r) => r.id)
      if (orphanIds.length > 0) {
        await chunkedInArrayDelete(orphanIds, (chunk) =>
          tx
            .delete(objects)
            .where(and(eq(objects.orgId, orgId), inArray(objects.id, chunk))),
        )
        for (const id of orphanIds) deletedObjectIds.add(id)
      }
    }
  }

  for (const claimId of multiSourceClaimIds) {
    const allEvidence = remainingByClaim.get(claimId) ?? []
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
      .where(eq(claims.id, claimId))

    stats.claimsUpdated++
  }

  return {
    deletedClaimIds: fullyOwnedClaimIds,
    updatedClaimIds: multiSourceClaimIds,
  }
}

/**
 * Removes all claim evidence tied to a repository (any path), reconciles affected
 * claims (recompute confidence or delete), and returns Falkor follow-up work.
 * Use when a repository is deleted: multi-source facts keep remaining proofs.
 *
 * Hot path is set-based: fully-repo-owned claims are bulk-deleted; only claims
 * that still have non-repo evidence get confidence updates.
 */
export async function purgeRepositoryEvidencePg(
  db: Db,
  params: { orgId: string; repositoryId: string },
): Promise<{
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
}> {
  const { orgId, repositoryId } = params
  const stats = emptyStats()
  const now = new Date()
  const deletedObjectIds = new Set<string>()
  let graphDeletedClaimIds: string[] = []
  let graphUpdatedClaimIds: string[] = []

  await db.transaction(async (tx) => {
    const started = Date.now()
    const rows = await tx
      .select({ id: claimEvidence.id, claimId: claimEvidence.claimId })
      .from(claimEvidence)
      .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
      .where(and(eq(claims.orgId, orgId), repoEvidenceFilter(repositoryId)))

    if (rows.length === 0) {
      graphDeletedClaimIds = []
      graphUpdatedClaimIds = []
      return
    }

    const outcome = await retractEvidenceRowsInTx(tx, {
      orgId,
      rows,
      now,
      stats,
      deletedObjectIds,
    })
    graphDeletedClaimIds = outcome.deletedClaimIds
    graphUpdatedClaimIds = outcome.updatedClaimIds

    log.info({
      step: "repositoryDeletion.evidence_purge.progress",
      message: "repositoryDeletion: evidence purge progress",
      repositoryId,
      deletedEvidenceRows: stats.deletedEvidenceRows,
      fullyOwnedDeleted: outcome.deletedClaimIds.length,
      multiSourceUpdated: outcome.updatedClaimIds.length,
      claimsDeleted: stats.claimsDeleted,
      claimsUpdated: stats.claimsUpdated,
      orphanObjectsDeleted: deletedObjectIds.size,
      durationMs: Date.now() - started,
    })
  })

  stats.orphanObjectsDeleted = deletedObjectIds.size

  return {
    stats,
    graphEffects: {
      deletedClaimIds: graphDeletedClaimIds,
      refreshedClaimIds: graphUpdatedClaimIds,
      deletedObjectIds: [...deletedObjectIds],
    },
  }
}

/** Connector warehouse prefixes whose Markdown must never have become instruction units (ADR-032 §4). */
const CONNECTOR_PREFIX_PATH_PATTERN =
  "^(github|linear|notion|slack|confluence)/"

/**
 * One-off cleanup (ADR-033 migration step): remove `InstructionUnit` objects
 * whose source path lives under a connector warehouse prefix, every claim that
 * touches them (evidence cascades), and any node left without claims (stub
 * root Services, derived Skills). Graph sync is deferred to
 * {@link applyIngestionRetractionGraphEffects}.
 */
export async function retractConnectorPrefixInstructionUnitsPg(
  db: Db,
  params: { orgId: string },
): Promise<{
  unitsDeleted: number
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
}> {
  const { orgId } = params
  const stats = emptyStats()
  const deletedObjectIds = new Set<string>()
  let unitsDeleted = 0
  let graphDeletedClaimIds: string[] = []

  await db.transaction(async (tx) => {
    const unitRows = await tx
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, orgId),
          eq(objects.kind, "InstructionUnit"),
          sql`${objects.payload}->>'path' ~ ${CONNECTOR_PREFIX_PATH_PATTERN}`,
        ),
      )
    const unitIds = unitRows.map((r) => r.id)
    if (unitIds.length === 0) return

    const claimRows = await chunkedInArraySelect(unitIds, (chunk) =>
      tx
        .select({
          id: claims.id,
          subjectId: claims.subjectId,
          objectId: claims.objectId,
        })
        .from(claims)
        .where(
          and(
            eq(claims.orgId, orgId),
            or(
              inArray(claims.subjectId, chunk),
              inArray(claims.objectId, chunk),
            ),
          ),
        ),
    )
    const claimIds = [...new Set(claimRows.map((r) => r.id))]

    const evidenceRows = await chunkedInArraySelect(claimIds, (chunk) =>
      tx
        .select({ id: claimEvidence.id })
        .from(claimEvidence)
        .where(inArray(claimEvidence.claimId, chunk)),
    )
    stats.deletedEvidenceRows = evidenceRows.length

    await chunkedInArrayDelete(claimIds, (chunk) =>
      tx
        .delete(claims)
        .where(and(eq(claims.orgId, orgId), inArray(claims.id, chunk))),
    )
    stats.claimsDeleted = claimIds.length
    graphDeletedClaimIds = claimIds

    await chunkedInArrayDelete(unitIds, (chunk) =>
      tx
        .delete(objects)
        .where(and(eq(objects.orgId, orgId), inArray(objects.id, chunk))),
    )
    unitsDeleted = unitIds.length
    for (const id of unitIds) deletedObjectIds.add(id)

    const otherEnds = new Set<string>()
    for (const row of claimRows) {
      for (const oid of [row.subjectId, row.objectId]) {
        if (!deletedObjectIds.has(oid)) otherEnds.add(oid)
      }
    }
    const orphanRows = await chunkedInArraySelect([...otherEnds], (chunk) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, orgId),
            inArray(objects.id, chunk),
            sql`NOT EXISTS (
              SELECT 1 FROM ${claims}
              WHERE ${claims.orgId} = ${orgId}
                AND (
                  ${claims.subjectId} = ${objects.id}
                  OR ${claims.objectId} = ${objects.id}
                )
            )`,
          ),
        ),
    )
    const orphanIds = orphanRows.map((r) => r.id)
    await chunkedInArrayDelete(orphanIds, (chunk) =>
      tx
        .delete(objects)
        .where(and(eq(objects.orgId, orgId), inArray(objects.id, chunk))),
    )
    stats.orphanObjectsDeleted = orphanIds.length
    for (const id of orphanIds) deletedObjectIds.add(id)
  })

  log.info({
    message: "retractConnectorPrefixInstructionUnits",
    orgId,
    unitsDeleted,
    claimsDeleted: stats.claimsDeleted,
    orphanObjectsDeleted: stats.orphanObjectsDeleted,
  })

  return {
    unitsDeleted,
    stats,
    graphEffects: {
      deletedClaimIds: graphDeletedClaimIds,
      refreshedClaimIds: [],
      deletedObjectIds: [...deletedObjectIds],
    },
  }
}

/** Evidence whose `${extractor}:${repositoryId}:` prefix marks this repository's ingestion as producer. */
function producedByRepositoryFilter(repositoryId: string) {
  return sql`split_part(${claimEvidence.sourceId}::text, ':', 2) = ${repositoryId}`
}

/**
 * After a successful full ingest at `targetHash`, retract evidence the run did not
 * re-observe: rows produced by this repository (second source-id segment) whose
 * source id does not end in `:${targetHash}`. Dedup moves re-observed rows to the
 * new hash, so they survive; evidence produced by other repositories that merely
 * mentions this one (PR mirror claims) is untouched. This is what keeps LLM naming
 * drift from accumulating across re-ingests (ADR-033).
 * Graph sync is deferred — use {@link applyIngestionRetractionGraphEffects}.
 */
export async function retractUnobservedRepositoryEvidencePg(
  db: Db,
  params: { orgId: string; repositoryId: string; targetHash: string },
): Promise<{
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
}> {
  const { orgId, repositoryId } = params
  const targetHash = params.targetHash.trim()
  if (targetHash.length === 0) {
    throw new Error(
      "retractUnobservedRepositoryEvidencePg: targetHash is required",
    )
  }
  const tail = `:${targetHash}`
  const stats = emptyStats()
  const now = new Date()
  const deletedObjectIds = new Set<string>()
  let deletedClaimIds: string[] = []
  let updatedClaimIds: string[] = []

  await db.transaction(async (tx) => {
    const started = Date.now()
    const rows = await tx
      .select({ id: claimEvidence.id, claimId: claimEvidence.claimId })
      .from(claimEvidence)
      .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
      .where(
        and(
          eq(claims.orgId, orgId),
          producedByRepositoryFilter(repositoryId),
          sql`right(${claimEvidence.sourceId}::text, ${tail.length}) <> ${tail}`,
        ),
      )
    if (rows.length === 0) return

    const outcome = await retractEvidenceRowsInTx(tx, {
      orgId,
      rows,
      now,
      stats,
      deletedObjectIds,
    })
    deletedClaimIds = outcome.deletedClaimIds
    updatedClaimIds = outcome.updatedClaimIds

    log.info({
      step: "repositoryIngestion.unobserved_evidence_sweep",
      message:
        "repositoryIngestion: retracted evidence not re-observed at target",
      repositoryId,
      targetHash,
      deletedEvidenceRows: stats.deletedEvidenceRows,
      claimsDeleted: stats.claimsDeleted,
      claimsUpdated: stats.claimsUpdated,
      orphanObjectsDeleted: deletedObjectIds.size,
      durationMs: Date.now() - started,
    })
  })

  stats.orphanObjectsDeleted = deletedObjectIds.size

  return {
    stats,
    graphEffects: {
      deletedClaimIds,
      refreshedClaimIds: updatedClaimIds,
      deletedObjectIds: [...deletedObjectIds],
    },
  }
}
