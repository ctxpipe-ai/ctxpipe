import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm"
import type { z } from "zod/v3"
import type { Db } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import type { ExtractionMethod, SourceType } from "../schema/claims.js"
import { aggregateConfidence } from "./confidenceAggregation.js"
import {
  deleteObjectFromGraph,
  refreshClaimProjection,
  retractClaimFromGraph,
} from "./graphProjection.js"
import { escapeRegex, normalizeGitPath } from "./ingestionPathMatching.js"

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
  /** Postgres: `claim_evidence` rows deleted for removed paths (within the PG transaction). */
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
  let graphEdgesDeleted = 0
  let graphClaimsRefreshed = 0
  let graphOrphanObjectsDeleted = 0

  for (const claimId of effects.deletedClaimIds) {
    await retractClaimFromGraph(claimId)
    graphEdgesDeleted++
  }

  for (const claimId of effects.refreshedClaimIds) {
    await refreshClaimProjection(claimId)
    graphClaimsRefreshed++
  }

  for (const objectId of effects.deletedObjectIds) {
    await deleteObjectFromGraph(objectId)
    graphOrphanObjectsDeleted++
  }

  return { graphEdgesDeleted, graphClaimsRefreshed, graphOrphanObjectsDeleted }
}

/**
 * Retracts stale evidence for a partial ingest diff: renames keys first, then deletes
 * evidence for removed paths. Reconciles claim aggregates and drops orphan claims.
 * Graph sync is deferred — use {@link applyIngestionRetractionGraphEffects} after commit.
 *
 * No-op when `ingestMode !== "partial"` or when there are no deleted paths or renames.
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
    deletedPaths: string[]
    renames: { from: string; to: string }[]
  },
): Promise<{
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
}> {
  const { orgId, repositoryId, ingestMode, deletedPaths, renames } = params

  const hasDiff = (deletedPaths?.length ?? 0) > 0 || (renames?.length ?? 0) > 0
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

    for (const rawPath of deletedPaths) {
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
