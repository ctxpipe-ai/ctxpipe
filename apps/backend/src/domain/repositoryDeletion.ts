import { and, eq } from "drizzle-orm"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { getOrgDb } from "../db/client.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { organizations } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { conversations } from "../db/schema/conversations.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import {
  TransientHttpError,
  withTransientHttpRetry,
} from "../lib/withTransientHttpRetry.js"
import { clearLinearSyncBindingsForRepository } from "../models/linear-connector.js"
import { DEFAULT_CHECKOUT_KEY } from "../models/repositories.js"
import { log } from "../observability/logger.js"
import { getGraphClient } from "../platform/graph/client.js"
import {
  applyIngestionRetractionGraphEffects,
  type IngestionRetractionGraphEffects,
  type RetractionStats,
  purgeRepositoryEvidencePg,
} from "../retrieval/services/ingestionRetraction.js"

async function mintCodesearchPurgeJwt(
  orgId: string,
  repositoryId: string,
): Promise<string> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo-purge:${repositoryId}`,
      orgId,
      principal: "service",
    },
  })
}

function logDeletionPhase(
  step: string,
  startedAt: number,
  fields: Record<string, unknown>,
): void {
  log.info({
    step,
    message: "repositoryDeletion: phase complete",
    durationMs: Date.now() - startedAt,
    ...fields,
  })
}

/**
 * Removes Zoekt shards and repo-cache files for a repository. Best-effort;
 * logs and continues if codesearch is unreachable.
 */
export async function notifyCodesearchRepositoryDeleted(params: {
  orgId: string
  repositoryId: string
  repoName: string
  zoektRepoId: number
}): Promise<void> {
  const url = `${codesearchBaseUrl()}/${params.repositoryId}/purge`
  const codesearchStarted = Date.now()
  try {
    const res = await withTransientHttpRetry(
      async () => {
        const token = await mintCodesearchPurgeJwt(
          params.orgId,
          params.repositoryId,
        )
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            zoektRepoId: params.zoektRepoId,
            repoName: params.repoName,
          }),
        })
        if ([502, 503, 504].includes(response.status)) {
          await response.text().catch(() => "")
          throw new TransientHttpError(
            `codesearch purge transient ${response.status}`,
            response.status,
          )
        }
        return response
      },
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      log.error({
        step: "repositoryDeletion.codesearch_purge",
        message: "repositoryDeletion: codesearch purge failed",
        repositoryId: params.repositoryId,
        status: res.status,
        body: text.slice(0, 500),
      })
    } else {
      logDeletionPhase("repositoryDeletion.codesearch", codesearchStarted, {
        repositoryId: params.repositoryId,
        zoektRepoId: params.zoektRepoId,
      })
    }
  } catch (e) {
    log.error({
      step: "repositoryDeletion.codesearch_purge_request",
      message: "repositoryDeletion: codesearch purge request failed",
      repositoryId: params.repositoryId,
      error: formatUnknownError(e),
    })
  }
}

/**
 * Drops the entire org graph from FalkorDB. Must be called inside
 * {@link withGraphClient} — the auth hook sets that up. FalkorDB uses
 * a separate graph per org (`selectGraph(orgId)`) so no property filter
 * is needed; `MATCH (n) DETACH DELETE n` wipes the whole tenant graph.
 */
export async function dropFalkorOrgGraph(orgId: string): Promise<void> {
  try {
    const driver = getGraphClient()
    await driver.executeQuery("MATCH (n) DETACH DELETE n")
  } catch (e) {
    log.error({
      step: "repositoryDeletion.falkor_purge",
      message: "repositoryDeletion: Falkor purge failed",
      orgId,
      error: formatUnknownError(e),
    })
  }
}

export type RepositoryDeletionPrepareResult = {
  found: boolean
  name: string | null
  zoektRepoId: number | null
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
}

export type RepositoryPostgresPurgeResult = {
  deleted: boolean
  alreadyGone: boolean
  name: string | null
  zoektRepoId: number | null
  stats: RetractionStats
  graphEffects: IngestionRetractionGraphEffects
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

function emptyGraphEffects(): IngestionRetractionGraphEffects {
  return {
    deletedClaimIds: [],
    refreshedClaimIds: [],
    deletedObjectIds: [],
  }
}

/**
 * Lookup + evidence reconciliation only (no repository row delete).
 * Must run inside {@link withOrgDbContext}. Kept separate from row delete so
 * OpenWorkflow can persist `graphEffects` before the row is removed.
 */
export async function prepareRepositoryDeletionPostgres(params: {
  orgId: string
  repositoryId: string
}): Promise<RepositoryDeletionPrepareResult> {
  const db = getOrgDb()
  const lookupStarted = Date.now()
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      zoektRepoId: repositoryCheckouts.zoektRepoId,
    })
    .from(repositories)
    .innerJoin(
      repositoryCheckouts,
      and(
        eq(repositoryCheckouts.repositoryId, repositories.id),
        eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
      ),
    )
    .where(
      and(
        eq(repositories.id, params.repositoryId),
        eq(repositories.orgId, params.orgId),
      ),
    )
    .limit(1)

  if (!row) {
    log.info({
      step: "repositoryDeletion.lookup",
      message: "repositoryDeletion: repository not found",
      repositoryId: params.repositoryId,
      durationMs: Date.now() - lookupStarted,
    })
    return {
      found: false,
      name: null,
      zoektRepoId: null,
      stats: emptyStats(),
      graphEffects: emptyGraphEffects(),
    }
  }

  logDeletionPhase("repositoryDeletion.lookup", lookupStarted, {
    repositoryId: params.repositoryId,
    zoektRepoId: row.zoektRepoId,
  })

  const evidenceStarted = Date.now()
  const { stats, graphEffects } = await purgeRepositoryEvidencePg(db, {
    orgId: params.orgId,
    repositoryId: params.repositoryId,
  })

  logDeletionPhase("repositoryDeletion.evidence_purge", evidenceStarted, {
    repositoryId: params.repositoryId,
    ...stats,
  })

  return {
    found: true,
    name: row.name,
    zoektRepoId: row.zoektRepoId,
    stats,
    graphEffects,
  }
}

/**
 * Deletes the repository row (cascades checkouts). Idempotent when already gone.
 * Must run inside {@link withOrgDbContext}.
 */
export async function deleteRepositoryRowPostgres(params: {
  orgId: string
  repositoryId: string
}): Promise<boolean> {
  const db = getOrgDb()
  const started = Date.now()
  // Linear sync binding lives in connections.config (no FK). Clear it first so
  // webhooks/UI cannot keep targeting a deleted repository.
  const linearCleared = await clearLinearSyncBindingsForRepository(params)
  const del = await db
    .delete(repositories)
    .where(
      and(
        eq(repositories.id, params.repositoryId),
        eq(repositories.orgId, params.orgId),
      ),
    )
  const deleted = Boolean(del.rowCount && del.rowCount > 0)
  logDeletionPhase("repositoryDeletion.delete_row", started, {
    repositoryId: params.repositoryId,
    deleted,
    linearCleared,
  })
  return deleted
}

/**
 * Postgres-only repository purge: evidence reconciliation + delete repo row.
 * Must run inside {@link withOrgDbContext}. Does not touch Falkor or codesearch.
 */
export async function purgeRepositoryPostgres(params: {
  orgId: string
  repositoryId: string
}): Promise<RepositoryPostgresPurgeResult> {
  const prepared = await prepareRepositoryDeletionPostgres(params)
  if (!prepared.found) {
    return {
      deleted: false,
      alreadyGone: true,
      name: null,
      zoektRepoId: null,
      stats: prepared.stats,
      graphEffects: prepared.graphEffects,
    }
  }

  const deleted = await deleteRepositoryRowPostgres(params)
  return {
    deleted,
    alreadyGone: false,
    name: prepared.name,
    zoektRepoId: prepared.zoektRepoId,
    stats: prepared.stats,
    graphEffects: prepared.graphEffects,
  }
}

/**
 * Best-effort Falkor cleanup after Postgres purge. Must run inside
 * {@link withGraphClient} and must not hold an org Postgres transaction.
 */
export async function applyRepositoryDeletionGraphCleanup(params: {
  repositoryId: string
  graphEffects: IngestionRetractionGraphEffects
}): Promise<void> {
  const graphSyncStarted = Date.now()
  await applyIngestionRetractionGraphEffects(params.graphEffects)
  logDeletionPhase("repositoryDeletion.graph_sync", graphSyncStarted, {
    repositoryId: params.repositoryId,
    deletedClaimIds: params.graphEffects.deletedClaimIds.length,
    refreshedClaimIds: params.graphEffects.refreshedClaimIds.length,
    deletedObjectIds: params.graphEffects.deletedObjectIds.length,
  })

  const falkorRepoStarted = Date.now()
  try {
    const driver = getGraphClient()
    await driver.executeQuery(`MATCH (n { id: $repoId }) DETACH DELETE n`, {
      repoId: params.repositoryId,
    })
    logDeletionPhase("repositoryDeletion.falkor_repo_node", falkorRepoStarted, {
      repositoryId: params.repositoryId,
    })
  } catch (e) {
    log.error({
      step: "repositoryDeletion.falkor_repo_node",
      message: "repositoryDeletion: failed to delete repo node from graph",
      repositoryId: params.repositoryId,
      error: formatUnknownError(e),
    })
  }
}

/**
 * Full cleanup when the caller already established org DB + graph context.
 *
 * Prefer phased helpers (`purgeRepositoryPostgres` then graph/codesearch
 * outside `withOrgDbContext`) for new code — this helper still runs graph and
 * codesearch after the inner PG transaction, but if the caller wraps the whole
 * call in `withOrgDbContext`, those side effects remain inside the outer txn.
 */
export async function deleteRepositoryWithCleanup(params: {
  orgId: string
  repositoryId: string
}): Promise<boolean> {
  const pg = await purgeRepositoryPostgres(params)
  if (pg.alreadyGone) return false

  await applyRepositoryDeletionGraphCleanup({
    repositoryId: params.repositoryId,
    graphEffects: pg.graphEffects,
  })

  if (pg.name != null && pg.zoektRepoId != null && pg.zoektRepoId > 0) {
    await notifyCodesearchRepositoryDeleted({
      orgId: params.orgId,
      repositoryId: params.repositoryId,
      repoName: pg.name,
      zoektRepoId: pg.zoektRepoId,
    })
  }

  return pg.deleted
}

/**
 * Wipes all org-scoped product data before Better Auth removes the organization row.
 *
 * Must be called inside {@link withOrgDbContext} (the hook in auth/config.ts
 * sets that up). Uses {@link getOrgDb} for all queries and deletes.
 * External side-effects (codesearch disk cleanup, FalkorDB graph drop) are
 * best-effort and run after the Postgres deletes.
 */
export async function purgeOrgDataBeforeAuthDelete(
  orgId: string,
): Promise<void> {
  const db = getOrgDb()

  const [orgRow] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  const orgSlug = orgRow?.slug

  if (!orgSlug) {
    log.error({
      step: "purgeOrgDataBeforeAuthDelete",
      message: "purgeOrgDataBeforeAuthDelete: organization not found",
      orgId,
    })
    return
  }

  const repoRows = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      zoektRepoId: repositoryCheckouts.zoektRepoId,
    })
    .from(repositories)
    .innerJoin(
      repositoryCheckouts,
      and(
        eq(repositoryCheckouts.repositoryId, repositories.id),
        eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
      ),
    )
    .where(eq(repositories.orgId, orgId))

  // claim_evidence cascades on claim deletion (FK onDelete: cascade).
  // repository_checkouts cascades on repo deletion (FK onDelete: cascade).
  await db.delete(claims).where(eq(claims.orgId, orgId))
  await db.delete(objects).where(eq(objects.orgId, orgId))
  await db.delete(conversations).where(eq(conversations.orgId, orgId))
  await db.delete(repositories).where(eq(repositories.orgId, orgId))

  // Best-effort: codesearch disk + FalkorDB
  for (const r of repoRows) {
    await notifyCodesearchRepositoryDeleted({
      orgId,
      repositoryId: r.id,
      repoName: r.name,
      zoektRepoId: r.zoektRepoId,
    })
  }

  await dropFalkorOrgGraph(orgId)
}
