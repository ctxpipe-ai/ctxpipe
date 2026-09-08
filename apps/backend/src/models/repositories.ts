import { and, count, eq, isNull, lte, or, sql } from "drizzle-orm"
import { repositoryRevisionCheckoutKey } from "../../../../shared/workspace-checkout.js"
import { requireCurrentOrgId } from "../auth/context.js"
import { type Db, getOrgDb, withOrgDbContext } from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type IndexingStepKey,
  resolveIndexingStep,
} from "../domain/indexingSteps.js"
import {
  applyRepositoryDeletionGraphCleanup,
  notifyCodesearchRepositoryDeleted,
  purgeRepositoryPostgres,
} from "../domain/repositoryDeletion.js"
import { workspaceCheckoutKey } from "../domain/workspaces/derived-stores.js"
import {
  normalizeWorkspaceRepositoryUrl,
  repositoryKeyFromGitUrl,
} from "../domain/workspaces/slug.js"
import { generateObjectId } from "../lib/id.js"
import { userFacingIndexingError } from "../lib/memoryFitError.js"
import { log } from "../observability/logger.js"
import { withGraphClient } from "../platform/graph/client.js"
import { projectRepositoryIngestionOwners } from "./repository-ingestion-owners.js"
import { repositoryIngestionWriteCondition } from "./repository-ingestion-requests.js"
import { invalidateLinkedReadBindings } from "./workspaces.js"

export const DEFAULT_CHECKOUT_KEY = "default"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

export async function ensureWorkspaceCheckout(input: {
  repositoryId: string
  workspaceId: string
  ref: string
}): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .insert(repositoryCheckouts)
      .values({
        id: generateObjectId("co"),
        orgId: requireCurrentOrgId(),
        repositoryId: input.repositoryId,
        ref: input.ref,
        checkoutKey: workspaceCheckoutKey(input.workspaceId, input.ref),
      })
      .onConflictDoNothing()
  })
}
/** Select only the successfully published immutable source, falling back to pre-upgrade artifacts. */
export function publishedRepositoryCheckoutKey() {
  return sql<string>`coalesce((select published.checkout_key from repository_checkouts published
    where published.repository_id = repositories.id and published.org_id = repositories.org_id
      and published.checkout_key = 'rev:' || repositories.last_ingested_hash
      and published.commit_sha = repositories.last_ingested_hash), 'default')`
}

export async function ensureRepositoryRevisionCheckout(input: {
  orgId: string
  repositoryId: string
  sha: string
}) {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .insert(repositoryCheckouts)
      .values({
        id: generateObjectId("co"),
        orgId: input.orgId,
        repositoryId: input.repositoryId,
        ref: input.sha,
        checkoutKey: repositoryRevisionCheckoutKey(input.sha),
      })
      .onConflictDoNothing(),
  )
}

const MAX_INDEXING_ERROR_CHARS = 500

export type RepositoryIndexingStatus = NonNullable<
  typeof repositories.$inferSelect.indexingStatus
>

/** Repository row shape used by API and tools (includes primary Zoekt id from default checkout). */
export type RepositoryWithSearch = typeof repositories.$inferSelect & {
  zoektRepoId: number
}

const repositoryWithZoektSelect = {
  id: repositories.id,
  orgId: repositories.orgId,
  name: repositories.name,
  gitUrl: repositories.gitUrl,
  repositoryKey: repositories.repositoryKey,
  indexReady: repositories.indexReady,
  indexingStatus: repositories.indexingStatus,
  indexingError: repositories.indexingError,
  indexingFailedAt: repositories.indexingFailedAt,
  indexingReason: repositories.indexingReason,
  indexingStep: repositories.indexingStep,
  indexingStepTotal: repositories.indexingStepTotal,
  indexingStepKey: repositories.indexingStepKey,
  lastIngestedHash: repositories.lastIngestedHash,
  lastIngestedAt: repositories.lastIngestedAt,
  githubConnectionId: repositories.githubConnectionId,
  createdAt: repositories.createdAt,
  updatedAt: repositories.updatedAt,
  zoektRepoId: repositoryCheckouts.zoektRepoId,
}

export function deriveRepositoryIndexingStatus(input: {
  indexReady: boolean
  indexingStatus: RepositoryIndexingStatus | null
}): RepositoryIndexingStatus {
  return input.indexingStatus ?? (input.indexReady ? "ready" : "running")
}

function sanitizeIndexingError(input: unknown): string {
  return userFacingIndexingError(input).slice(0, MAX_INDEXING_ERROR_CHARS)
}

function repositoryWithZoektJoin(db: Pick<Db, "select">) {
  return db
    .select(repositoryWithZoektSelect)
    .from(repositories)
    .innerJoin(
      repositoryCheckouts,
      and(
        eq(repositoryCheckouts.repositoryId, repositories.id),
        eq(repositoryCheckouts.checkoutKey, publishedRepositoryCheckoutKey()),
      ),
    )
}

async function selectRepositoriesWithZoekt(
  db: Db,
  orgId: string,
  githubConnectionId?: string,
) {
  const rows = await repositoryWithZoektJoin(db).where(
    githubConnectionId
      ? and(
          eq(repositories.orgId, orgId),
          eq(repositories.githubConnectionId, githubConnectionId),
        )
      : eq(repositories.orgId, orgId),
  )
  return projectRepositoryIngestionOwners(db, orgId, rows)
}

async function selectRepositoryWithZoekt(
  db: Db,
  orgId: string,
  repositoryId: string,
) {
  const [row] = await repositoryWithZoektJoin(db)
    .where(
      and(eq(repositories.id, repositoryId), eq(repositories.orgId, orgId)),
    )
    .limit(1)
  return row
    ? ((await projectRepositoryIngestionOwners(db, orgId, [row]))[0] ?? null)
    : null
}

export const listRepositories = async (): Promise<RepositoryWithSearch[]> => {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    return selectRepositoriesWithZoekt(db, orgId)
  })
}

export const listRepositoriesForGithubConnection = async (
  githubConnectionId: string,
): Promise<RepositoryWithSearch[]> => {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    return selectRepositoriesWithZoekt(db, orgId, githubConnectionId)
  })
}

/** Repositories linked to this GitHub App connection (`github_connection_id`). */
export async function countRepositoriesForGithubConnection(
  githubConnectionId: string,
): Promise<number> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [row] = await db
      .select({ value: count() })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, orgId),
          eq(repositories.githubConnectionId, githubConnectionId),
        ),
      )
    const raw = row?.value
    const n =
      raw == null
        ? 0
        : typeof raw === "bigint"
          ? Number(raw)
          : typeof raw === "number"
            ? raw
            : Number(raw)
    if (!Number.isFinite(n) || n < 0) return 0
    return Math.trunc(n)
  })
}

/** Repos linked to a GitHub connection whose gitUrl is not in the allowed set. */
export async function pruneGithubConnectionRepositoriesNotInGitUrls(
  orgId: string,
  githubConnectionId: string,
  allowedGitUrls: Set<string>,
): Promise<void> {
  const rows = await orgSql(async () => {
    const db = getOrgDb()
    return db
      .select({
        id: repositories.id,
        gitUrl: repositories.gitUrl,
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
          eq(repositories.orgId, orgId),
          eq(repositories.githubConnectionId, githubConnectionId),
        ),
      )
  })
  const { enqueueRepositoryDeletionWorkflow } = await import(
    "../openworkflow/enqueue-repository-deletion.js"
  )
  for (const row of rows) {
    if (allowedGitUrls.has(row.gitUrl)) continue
    await enqueueRepositoryDeletionWorkflow(
      {
        orgId,
        repositoryId: row.id,
        repoName: row.name,
        zoektRepoId: row.zoektRepoId,
      },
      {
        error: (err) =>
          log.error({
            step: "repositories.prune.enqueue-deletion",
            repositoryId: row.id,
            orgId,
            error: err.message,
          }),
      },
    )
  }
}

export async function findRepositoriesByNormalizedGitUrls(
  urls: readonly string[],
): Promise<Array<{ id: string; gitUrl: string }>> {
  if (urls.length === 0) return []
  const wanted = new Set(
    urls.map((url) => normalizeWorkspaceRepositoryUrl(url)).filter(Boolean),
  )
  if (wanted.size === 0) return []
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({ id: repositories.id, gitUrl: repositories.gitUrl })
      .from(repositories)
      .where(eq(repositories.orgId, requireCurrentOrgId()))
    return rows.filter((row) =>
      wanted.has(normalizeWorkspaceRepositoryUrl(row.gitUrl)),
    )
  })
}

export async function setRepositoryGithubConnectionId(input: {
  repositoryId: string
  githubConnectionId: string
}): Promise<void> {
  return orgSql(async () => {
    const db = getOrgDb()
    const [repository] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.orgId, requireCurrentOrgId()),
        ),
      )
      .for("update")
    if (
      !repository ||
      repository.githubConnectionId === input.githubConnectionId
    )
      return
    await db
      .update(repositories)
      .set({ githubConnectionId: input.githubConnectionId })
      .where(eq(repositories.id, repository.id))
    await invalidateLinkedReadBindings([repository.gitUrl])
  })
}

/** Returns repositories for org via org DB (explicit orgId filter). */
export const listRepositoriesForOrg = async (
  orgId: string,
): Promise<RepositoryWithSearch[]> => {
  return withOrgDbContext(orgId, () =>
    selectRepositoriesWithZoekt(getOrgDb(), orgId),
  )
}

/** Read identity is available before any derived checkout or index exists. */
export async function getRepositoryReadBinding(
  orgId: string,
  repositoryId: string,
) {
  return withOrgDbContext(orgId, async (db) => {
    const [row] = await db
      .select({
        id: repositories.id,
        gitUrl: repositories.gitUrl,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(
        and(eq(repositories.orgId, orgId), eq(repositories.id, repositoryId)),
      )
      .limit(1)
    return row ?? null
  })
}

/** Single repository for org via org DB (explicit orgId + repositoryId filter). */
export const getRepositoryForOrg = async (
  orgId: string,
  repositoryId: string,
): Promise<RepositoryWithSearch | null> => {
  return withOrgDbContext(orgId, () =>
    selectRepositoryWithZoekt(getOrgDb(), orgId, repositoryId),
  )
}

export const getRepository = async (
  repositoryId: string,
): Promise<RepositoryWithSearch | null> => {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    return selectRepositoryWithZoekt(db, orgId, repositoryId)
  })
}

/** For worker/ingestion paths: requires org DB context (`withOrgDbContext`). */
export async function getGithubConnectionIdForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<string | null> {
  return orgSql(async () => {
    const db = getOrgDb()
    const [row] = await db
      .select({ githubConnectionId: repositories.githubConnectionId })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.orgId, input.orgId),
        ),
      )
      .limit(1)
    return row?.githubConnectionId ?? null
  })
}

/** Marks a repository as mid-unindex for UI before background cleanup runs. */
export async function markRepositoryUnindexing(input: {
  repositoryId: string
}): Promise<{ updatedAt: Date } | null> {
  return orgSql(async () => {
    const db = getOrgDb()
    const updatedAt = new Date()
    const result = await db
      .update(repositories)
      .set({
        indexReady: false,
        indexingStatus: "unindexing",
        indexingReason: null,
        indexingStep: null,
        indexingStepTotal: null,
        indexingStepKey: null,
        updatedAt,
      })
      .where(eq(repositories.id, input.repositoryId))
    if (!result.rowCount || result.rowCount <= 0) return null
    return { updatedAt }
  })
}

/** Marks repository ingestion as actively running inside the workflow worker. */
export async function markRepositoryIndexingRunning(input: {
  repositoryId: string
  requestId?: string | null
}) {
  return orgSql(async () => {
    const db = getOrgDb()
    await db
      .update(repositories)
      .set({
        indexReady: false,
        indexingStatus: "running",
        indexingError: null,
        indexingFailedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          repositoryIngestionWriteCondition(input.requestId),
        ),
      )
  })
}

export async function markRepositoryIndexingReady(input: {
  repositoryId: string
  requestId?: string | null
  targetHash: string
}) {
  return orgSql(async () => {
    const db = getOrgDb()
    await db
      .update(repositories)
      .set({
        indexReady: true,
        indexingStatus: "ready",
        indexingError: null,
        indexingFailedAt: null,
        indexingReason: null,
        indexingStep: null,
        indexingStepTotal: null,
        indexingStepKey: null,
        lastIngestedHash: input.targetHash,
        lastIngestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          repositoryIngestionWriteCondition(input.requestId),
        ),
      )
  })
}

export async function markRepositoryIndexingReadyWithIssues(input: {
  repositoryId: string
  requestId?: string | null
  targetHash: string
  error: unknown
}) {
  return orgSql(async () => {
    const db = getOrgDb()
    await db
      .update(repositories)
      .set({
        indexReady: true,
        indexingStatus: "complete_with_issues",
        indexingError: sanitizeIndexingError(input.error),
        indexingFailedAt: null,
        indexingReason: null,
        indexingStep: null,
        indexingStepTotal: null,
        indexingStepKey: null,
        lastIngestedHash: input.targetHash,
        lastIngestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          repositoryIngestionWriteCondition(input.requestId),
        ),
      )
  })
}

/**
 * Updates the three indexing-step columns for a repository mid-ingestion run.
 * Resolves `step` and `total` from the catalog; no-ops when the key is unknown.
 *
 * When `monotonic` is true, the update is skipped when the DB already holds a
 * step number greater than the new one (prevents parallel nodes from regressing).
 *
 * For worker/ingestion paths: requires org DB context (`withOrgDbContext`).
 */
export async function setRepositoryIndexingStep(input: {
  repositoryId: string
  requestId?: string | null
  key: IndexingStepKey
  scipLanguages?: string[]
  /** Only advance the step counter — skip the update when DB step > new step. */
  monotonic?: boolean
}): Promise<void> {
  return orgSql(async () => {
    const resolution = resolveIndexingStep(input.key, input.scipLanguages)
    if (!resolution) return
    const db = getOrgDb()
    const idCondition = and(
      eq(repositories.id, input.repositoryId),
      repositoryIngestionWriteCondition(input.requestId),
    )
    const where = input.monotonic
      ? and(
          idCondition,
          or(
            isNull(repositories.indexingStep),
            lte(repositories.indexingStep, resolution.step),
          ),
        )
      : idCondition
    await db
      .update(repositories)
      .set({
        indexingStep: resolution.step,
        indexingStepTotal: resolution.total,
        indexingStepKey: resolution.key,
        updatedAt: new Date(),
      })
      .where(where)
  })
}

/**
 * Clears the three indexing-step columns (sets to null).
 * Prefer calling this explicitly from paths that do not go through
 * markRepositoryIndexingReady / markRepositoryUnindexing.
 *
 * For worker/ingestion paths: requires org DB context (`withOrgDbContext`).
 */
export async function clearRepositoryIndexingStep(input: {
  repositoryId: string
}): Promise<void> {
  return orgSql(async () => {
    const db = getOrgDb()
    await db
      .update(repositories)
      .set({
        indexingStep: null,
        indexingStepTotal: null,
        indexingStepKey: null,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, input.repositoryId))
  })
}

/** Match GitHub `full_name` for a specific GitHub connection only.
 *  Assumes caller has established org DB context. */
export async function findRepositoryByGithubInstallation(
  orgId: string,
  fullName: string,
  githubConnectionId: string,
) {
  return orgSql(async () => {
    const db = getOrgDb()
    const [row] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, orgId),
          eq(repositories.name, fullName),
          eq(repositories.githubConnectionId, githubConnectionId),
        ),
      )
      .limit(1)
    return row
  })
}

export const createRepository = async (input: {
  name: string
  gitUrl: string
}): Promise<RepositoryWithSearch> => {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const id = generateObjectId("repo")
    const db = getOrgDb()
    const checkoutId = generateObjectId("co")
    const [row] = await db.transaction(async (tx) => {
      const [repository] = await tx
        .insert(repositories)
        .values({
          id,
          orgId: orgId,
          name: input.name,
          gitUrl: input.gitUrl,
          repositoryKey: repositoryKeyFromGitUrl(input.gitUrl),
        })
        .onConflictDoNothing()
        .returning()
      if (!repository)
        return repositoryWithZoektJoin(tx).where(
          and(
            eq(repositories.orgId, orgId),
            eq(repositories.gitUrl, input.gitUrl),
          ),
        )
      const [checkout] = await tx
        .insert(repositoryCheckouts)
        .values({
          id: checkoutId,
          orgId,
          repositoryId: repository.id,
          ref: "main",
          checkoutKey: DEFAULT_CHECKOUT_KEY,
        })
        .returning({
          zoektRepoId: repositoryCheckouts.zoektRepoId,
        })
      if (!checkout) return []
      return [
        {
          ...repository,
          zoektRepoId: checkout.zoektRepoId,
        } satisfies RepositoryWithSearch,
      ]
    })
    if (row) return row
    throw new Error("Failed to create repository")
  })
}

/**
 * Insert multiple repositories in a single query. Skips repos that already
 * exist (by gitUrl + orgId) via ON CONFLICT DO NOTHING. Returns only the newly created rows.
 * Must be called from a context where getOrgDb() is set (request middleware or inside withOrgDbContext).
 */
async function bulkCreateRepositoriesWithDb(
  orgId: string,
  input: Array<{ name: string; gitUrl: string }>,
  opts?: { githubConnectionId: string },
) {
  if (input.length === 0) return []
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const created: RepositoryWithSearch[] = []
    for (const r of input) {
      const [repository] = await tx
        .insert(repositories)
        .values({
          id: generateObjectId("repo"),
          orgId,
          name: r.name,
          gitUrl: r.gitUrl,
          repositoryKey: repositoryKeyFromGitUrl(r.gitUrl),
          githubConnectionId: opts?.githubConnectionId,
        })
        .onConflictDoNothing({
          target: [repositories.gitUrl, repositories.orgId],
        })
        .returning()
      if (!repository) continue
      const [checkout] = await tx
        .insert(repositoryCheckouts)
        .values({
          id: generateObjectId("co"),
          orgId,
          repositoryId: repository.id,
          ref: "main",
          checkoutKey: DEFAULT_CHECKOUT_KEY,
        })
        .returning({ zoektRepoId: repositoryCheckouts.zoektRepoId })
      if (!checkout) continue
      created.push({ ...repository, zoektRepoId: checkout.zoektRepoId })
    }
    return created
  })
}

/**
 * Bulk create repositories for an org from workflow/worker context (no Hono org context).
 * Uses withOrgDbContext so getOrgDb() and org-scoped logic work.
 */
export const bulkCreateRepositoriesForOrg = async (
  orgId: string,
  input: Array<{ name: string; gitUrl: string }>,
  opts?: { githubConnectionId: string },
) => {
  return withOrgDbContext(orgId, () =>
    bulkCreateRepositoriesWithDb(orgId, input, opts),
  )
}

/**
 * Synchronous phased delete (tests / scripts). Prefer
 * {@link enqueueRepositoryDeletionWorkflow} for API/prune paths so cleanup
 * survives process restarts and does not hold a PG txn across Falkor/HTTP.
 *
 * Postgres purge runs in a short `withOrgDbContext`; graph + codesearch run
 * after that transaction commits.
 */
export async function deleteRepository(params: {
  orgId: string
  orgSlug: string
  repositoryId: string
}): Promise<boolean> {
  const pg = await withOrgDbContext(params.orgId, () =>
    purgeRepositoryPostgres({
      orgId: params.orgId,
      repositoryId: params.repositoryId,
    }),
  )
  if (pg.alreadyGone) return false

  await withGraphClient({ orgId: params.orgId, orgSlug: params.orgSlug }, () =>
    applyRepositoryDeletionGraphCleanup({
      repositoryId: params.repositoryId,
      graphEffects: pg.graphEffects,
    }),
  )

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
