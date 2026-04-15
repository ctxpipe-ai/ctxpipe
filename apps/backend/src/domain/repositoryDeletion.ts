import { and, eq, inArray } from "drizzle-orm"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { getOrgDb, getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { conversations } from "../db/schema/conversations.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { DEFAULT_CHECKOUT_KEY } from "../models/repositories.js"
import { logWideEvent } from "../observability/logger.js"
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
  zoektRepoId: number
}): Promise<void> {
  let token: string
  try {
    token = await mintCodesearchPurgeJwt(params.orgId, params.repositoryId)
  } catch (e) {
    logWideEvent("error", "repositoryDeletion: JWT for codesearch failed", {
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
      logWideEvent("error", "repositoryDeletion: codesearch purge failed", {
        repositoryId: params.repositoryId,
        status: res.status,
        body: text.slice(0, 500),
      })
    }
  } catch (e) {
    logWideEvent(
      "error",
      "repositoryDeletion: codesearch purge request failed",
      {
        repositoryId: params.repositoryId,
        error: e instanceof Error ? e.message : String(e),
      },
    )
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
    logWideEvent("error", "repositoryDeletion: Falkor purge failed", {
      orgId: params.orgId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Deletes a repository row after removing ingestion evidence (multi-source
 * facts reconciled), Falkor projections, and codesearch disk/Zoekt state.
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

  const { stats, graphEffects } = await purgeRepositoryEvidencePg(db, {
    orgId: params.orgId,
    repositoryId: params.repositoryId,
  })
  await applyIngestionRetractionGraphEffects(graphEffects)
  if (
    stats.deletedEvidenceRows > 0 ||
    stats.claimsUpdated > 0 ||
    stats.claimsDeleted > 0
  ) {
    logWideEvent("info", "repositoryDeletion: evidence purge", {
      repositoryId: params.repositoryId,
      ...stats,
    })
  }

  await notifyCodesearchRepositoryDeleted({
    orgId: params.orgId,
    repositoryId: row.id,
    zoektRepoId: row.zoektRepoId,
  })

  const del = await db
    .delete(repositories)
    .where(
      and(
        eq(repositories.id, params.repositoryId),
        eq(repositories.orgId, params.orgId),
      ),
    )
  return Boolean(del.rowCount && del.rowCount > 0)
}

/**
 * Wipes all org-scoped product data before Better Auth removes the organization row.
 */
export async function purgeOrgDataBeforeAuthDelete(
  orgId: string,
): Promise<void> {
  const [orgRow] = await getSystemDb()
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  const orgSlug = orgRow?.slug
  if (!orgSlug) {
    logWideEvent(
      "error",
      "purgeOrgDataBeforeAuthDelete: organization not found",
      { orgId },
    )
    return
  }

  const repoRows = await getSystemDb()
    .select({
      id: repositories.id,
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

  for (const r of repoRows) {
    await notifyCodesearchRepositoryDeleted({
      orgId,
      repositoryId: r.id,
      zoektRepoId: r.zoektRepoId,
    })
  }

  await withOrgDbContext(orgId, async (db) => {
    const claimIdRows = await db
      .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.orgId, orgId))
    const claimIds = claimIdRows.map((r) => r.id)
    if (claimIds.length > 0) {
      await db
        .delete(claimEvidence)
        .where(inArray(claimEvidence.claimId, claimIds))
    }
    await db.delete(claims).where(eq(claims.orgId, orgId))
    await db.delete(objects).where(eq(objects.orgId, orgId))
    await db.delete(conversations).where(eq(conversations.orgId, orgId))
    await db.delete(repositories).where(eq(repositories.orgId, orgId))
  })

  await dropFalkorOrgGraph({ orgId, orgSlug })
}
