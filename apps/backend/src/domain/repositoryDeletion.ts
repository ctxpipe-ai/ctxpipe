import { and, eq } from "drizzle-orm"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { conversations } from "../db/schema/conversations.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { DEFAULT_CHECKOUT_KEY } from "../models/repositories.js"
import { log } from "../observability/logger.js"
import { getGraphClient, withGraphClient } from "../platform/graph/client.js"
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

export async function dropFalkorOrgGraph(params: {
  orgId: string
  orgSlug: string
}): Promise<void> {
  try {
    await withGraphClient(
      { orgId: params.orgId, orgSlug: params.orgSlug },
      async () => {
        const driver = getGraphClient()
        await driver.executeQuery(
          `MATCH (n { orgId: $orgId }) DETACH DELETE n`,
          { orgId: params.orgId },
        )
      },
    )
  } catch (e) {
    log.error({
      step: "repositoryDeletion.falkor_purge",
      message: "repositoryDeletion: Falkor purge failed",
      orgId: params.orgId,
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
export async function deleteRepositoryWithCleanup(params: {
  orgId: string
  orgSlug: string
  repositoryId: string
}): Promise<boolean> {
  const db = getOrgDb()
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
    return false
  }

  // Atomic: evidence reconciliation + repo row deletion in one transaction.
  // Deleting the repositories row cascades to repository_checkouts.
  // purgeRepositoryEvidencePg opens a nested savepoint inside this transaction.
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

  if (
    stats.deletedEvidenceRows > 0 ||
    stats.claimsUpdated > 0 ||
    stats.claimsDeleted > 0
  ) {
    log.info({
      step: "repositoryDeletion.evidence_purge",
      message: "repositoryDeletion: evidence purge",
      repositoryId: params.repositoryId,
      ...stats,
    })
  }

  // Best-effort post-commit: graph sync and codesearch disk cleanup
  await applyIngestionRetractionGraphEffects(graphEffects)

  // Remove the Repository node itself from FalkorDB (claim edges were handled
  // above via graphEffects; this catches the node that may remain as an orphan).
  try {
    await withGraphClient(
      { orgId: params.orgId, orgSlug: params.orgSlug },
      async () => {
        const driver = getGraphClient()
        await driver.executeQuery(`MATCH (n { id: $repoId }) DETACH DELETE n`, {
          repoId: params.repositoryId,
        })
      },
    )
  } catch (e) {
    log.error({
      step: "repositoryDeletion.falkor_repo_node",
      message: "repositoryDeletion: failed to delete repo node from graph",
      repositoryId: params.repositoryId,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  await notifyCodesearchRepositoryDeleted({
    orgId: params.orgId,
    repositoryId: row.id,
    repoName: row.name,
    zoektRepoId: row.zoektRepoId,
  })

  return deleted
}

/**
 * Wipes all org-scoped product data before Better Auth removes the organization row.
 *
 * All Postgres queries and deletes run inside {@link withOrgDbContext} so the
 * org-scoped transaction context is set. External side-effects (codesearch
 * disk cleanup, FalkorDB graph drop) run after the transaction commits.
 */
export async function purgeOrgDataBeforeAuthDelete(
  orgId: string,
): Promise<void> {
  const { orgSlug, repoRows } = await withOrgDbContext(orgId, async (db) => {
    const [orgRow] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)

    if (!orgRow?.slug) {
      log.error({
        step: "purgeOrgDataBeforeAuthDelete",
        message: "purgeOrgDataBeforeAuthDelete: organization not found",
        orgId,
      })
      return { orgSlug: undefined, repoRows: [] }
    }

    const repos = await db
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

    return { orgSlug: orgRow.slug, repoRows: repos }
  })

  if (!orgSlug) return

  // Best-effort post-commit: codesearch disk + FalkorDB
  for (const r of repoRows) {
    await notifyCodesearchRepositoryDeleted({
      orgId,
      repositoryId: r.id,
      repoName: r.name,
      zoektRepoId: r.zoektRepoId,
    })
  }

  await dropFalkorOrgGraph({ orgId, orgSlug })
}
