import { and, eq } from "drizzle-orm"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { getOrgDb } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { conversations } from "../db/schema/conversations.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { DEFAULT_CHECKOUT_KEY } from "../models/repositories.js"
import { log } from "../observability/logger.js"
import { getGraphClient } from "../platform/graph/client.js"
import {
  applyIngestionRetractionGraphEffects,
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
  let token: string
  try {
    token = await mintCodesearchPurgeJwt(params.orgId, params.repositoryId)
  } catch (e) {
    log.error({
      step: "repositoryDeletion.codesearch_jwt",
      message: "repositoryDeletion: JWT for codesearch failed",
      repositoryId: params.repositoryId,
      error: e instanceof Error ? e.message : String(e),
    })
    return
  }
  const url = `${codesearchBaseUrl()}/${params.repositoryId}/purge`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ zoektRepoId: params.zoektRepoId }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      log.error({
        step: "repositoryDeletion.codesearch_purge",
        message: "repositoryDeletion: codesearch purge failed",
        repositoryId: params.repositoryId,
        status: res.status,
        body: text.slice(0, 500),
      })
    }
  } catch (e) {
    log.error({
      step: "repositoryDeletion.codesearch_purge_request",
      message: "repositoryDeletion: codesearch purge request failed",
      repositoryId: params.repositoryId,
      error: e instanceof Error ? e.message : String(e),
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
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Deletes a repository row after removing ingestion evidence (multi-source
 * facts reconciled), Falkor projections, and codesearch disk/Zoekt state.
 *
 * Postgres operations (evidence purge + repo row delete) run in a single
 * transaction so a crash cannot leave orphaned state. Graph and codesearch
 * calls are best-effort and run after commit.
 */
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

export async function deleteRepositoryWithCleanup(params: {
  orgId: string
  repositoryId: string
}): Promise<boolean> {
  const overallStarted = Date.now()
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
    return false
  }

  logDeletionPhase("repositoryDeletion.lookup", lookupStarted, {
    repositoryId: params.repositoryId,
    zoektRepoId: row.zoektRepoId,
  })

  // Atomic: evidence reconciliation + repo row deletion in one transaction.
  // Deleting the repositories row cascades to repository_checkouts.
  // purgeRepositoryEvidencePg opens a nested savepoint inside this transaction.
  const pgStarted = Date.now()
  const { stats, graphEffects, deleted } = await db.transaction(async (tx) => {
    const result = await purgeRepositoryEvidencePg(tx, {
      orgId: params.orgId,
      repositoryId: params.repositoryId,
    })

    const del = await tx
      .delete(repositories)
      .where(
        and(
          eq(repositories.id, params.repositoryId),
          eq(repositories.orgId, params.orgId),
        ),
      )

    return {
      ...result,
      deleted: Boolean(del.rowCount && del.rowCount > 0),
    }
  })

  logDeletionPhase("repositoryDeletion.postgres", pgStarted, {
    repositoryId: params.repositoryId,
    deleted,
    ...stats,
  })

  const graphSyncStarted = Date.now()
  await applyIngestionRetractionGraphEffects(graphEffects)
  logDeletionPhase("repositoryDeletion.graph_sync", graphSyncStarted, {
    repositoryId: params.repositoryId,
    deletedClaimIds: graphEffects.deletedClaimIds.length,
    refreshedClaimIds: graphEffects.refreshedClaimIds.length,
    deletedObjectIds: graphEffects.deletedObjectIds.length,
  })

  // Remove the Repository node itself from FalkorDB (claim edges were handled
  // above via graphEffects; this catches the node that may remain as an orphan).
  // Caller must have set up withGraphClient context.
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
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const codesearchStarted = Date.now()
  await notifyCodesearchRepositoryDeleted({
    orgId: params.orgId,
    repositoryId: row.id,
    repoName: row.name,
    zoektRepoId: row.zoektRepoId,
  })
  logDeletionPhase("repositoryDeletion.codesearch", codesearchStarted, {
    repositoryId: params.repositoryId,
    zoektRepoId: row.zoektRepoId,
  })

  log.info({
    step: "repositoryDeletion.complete",
    message: "repositoryDeletion: finished",
    repositoryId: params.repositoryId,
    deleted,
    durationMs: Date.now() - overallStarted,
  })

  return deleted
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
