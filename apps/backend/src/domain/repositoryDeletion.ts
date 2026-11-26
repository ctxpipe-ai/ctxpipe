import { and, eq } from "drizzle-orm"

import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import {
  assertNotInOrgDbContext,
  getOrgDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { conversations } from "../db/schema/conversations.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import {
  TransientHttpError,
  withTransientHttpRetry,
} from "../lib/withTransientHttpRetry.js"
import { clearLinearSyncBindingsForRepository } from "../models/linear-connector.js"
import { clearNotionSyncBindingsForRepository } from "../models/notion-connector.js"
import { clearPagerdutySyncBindingsForRepository } from "../models/pagerduty-connector.js"
import { DEFAULT_CHECKOUT_KEY } from "../models/repositories.js"
import { clearSlackSyncBindingsForRepository } from "../models/slack-connector.js"
import { log } from "../observability/logger.js"
import {
  purgeRepositoryEvidencePg,
  type RetractionStats,
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
  assertNotInOrgDbContext()
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
        "upstream.status_code": res.status,
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

type RepositoryDeletionPrepareResult = {
  found: boolean
  name: string | null
  zoektRepoId: number | null
  stats: RetractionStats
}

type RepositoryPostgresPurgeResult = {
  deleted: boolean
  alreadyGone: boolean
  name: string | null
  zoektRepoId: number | null
  stats: RetractionStats
}

function emptyStats(): RetractionStats {
  return {
    renamedEvidenceRows: 0,
    deletedEvidenceRows: 0,
    claimsUpdated: 0,
    claimsDeleted: 0,
    orphanObjectsDeleted: 0,
  }
}

/**
 * Lookup + evidence reconciliation only (no repository row delete).
 * Must run inside {@link withOrgDbContext}. Kept separate from row delete so
 * OpenWorkflow can persist the lookup before the row is removed.
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
    }
  }

  logDeletionPhase("repositoryDeletion.lookup", lookupStarted, {
    repositoryId: params.repositoryId,
    zoektRepoId: row.zoektRepoId,
  })

  const evidenceStarted = Date.now()
  const { stats } = await purgeRepositoryEvidencePg(db, {
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
  // Connector sync bindings live in connections.config (no FK). Clear them first so
  // webhooks/UI cannot keep targeting a deleted repository.
  const linearCleared = await clearLinearSyncBindingsForRepository(params)
  const notionCleared = await clearNotionSyncBindingsForRepository(params)
  const slackCleared = await clearSlackSyncBindingsForRepository(params)
  const pagerdutyCleared = await clearPagerdutySyncBindingsForRepository(params)
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
    notionCleared,
    slackCleared,
    pagerdutyCleared,
  })
  return deleted
}

/**
 * Postgres-only repository purge: evidence reconciliation + delete repo row.
 * Must run inside {@link withOrgDbContext}. Does not touch codesearch.
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
    }
  }

  const deleted = await deleteRepositoryRowPostgres(params)
  return {
    deleted,
    alreadyGone: false,
    name: prepared.name,
    zoektRepoId: prepared.zoektRepoId,
    stats: prepared.stats,
  }
}

/**
 * Wipes all org-scoped product data before Better Auth removes the organization
 * row.
 *
 * Call it outside an org SQL transaction: it opens its own
 * ({@link withOrgDbContext}, with {@link getOrgDb} for all queries and
 * deletes), and then queues a workflow and calls codesearch. The codesearch disk cleanup is
 * best-effort and runs after the Postgres deletes. The worker deletes the
 * ClickHouse rows of the knowledge plane (`knowledge-purge`): this function
 * queues that purge after the Postgres deletes.
 */
export async function purgeOrgDataBeforeAuthDelete(
  orgId: string,
): Promise<void> {
  const prepared = await withOrgDbContext(orgId, async () => {
    const db = getOrgDb()
    const [orgRow] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    if (!orgRow) return null

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

    await db.delete(claims).where(eq(claims.orgId, orgId))
    await db.delete(objects).where(eq(objects.orgId, orgId))
    await db.delete(conversations).where(eq(conversations.orgId, orgId))
    await db.delete(repositories).where(eq(repositories.orgId, orgId))
    return { repoRows }
  })

  if (!prepared) {
    log.error({
      step: "purgeOrgDataBeforeAuthDelete",
      message: "purgeOrgDataBeforeAuthDelete: organization not found",
      orgId,
    })
    return
  }

  // A failed enqueue fails the hook, so the organization row stays, and a
  // retry of the delete queues the purge again. A dynamic import: the
  // OpenWorkflow client connects when it loads, and it needs DATABASE_URL.
  const { enqueueKnowledgePurge } =
    await import("../openworkflow/enqueue-knowledge-purge.js")
  await enqueueKnowledgePurge({ orgId, workspaceId: null })

  for (const r of prepared.repoRows) {
    await notifyCodesearchRepositoryDeleted({
      orgId,
      repositoryId: r.id,
      repoName: r.name,
      zoektRepoId: r.zoektRepoId,
    })
  }
}
