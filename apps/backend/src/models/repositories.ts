import { and, count, eq } from "drizzle-orm"
import { requireCurrentOrgId, requireCurrentOrgSlug } from "../auth/context.js"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { deleteRepositoryWithCleanup } from "../domain/repositoryDeletion.js"
import { generateObjectId } from "../lib/id.js"
import { withGraphClient } from "../platform/graph/client.js"

export const DEFAULT_CHECKOUT_KEY = "default"

/** Repository row shape used by API and tools (includes primary Zoekt id from default checkout). */
export type RepositoryWithSearch = typeof repositories.$inferSelect & {
  zoektRepoId: number
}

async function selectRepositoriesWithZoekt(
  db: ReturnType<typeof getOrgDb>,
  orgId: string,
  githubConnectionId?: string,
) {
  return db
    .select({
      id: repositories.id,
      orgId: repositories.orgId,
      name: repositories.name,
      gitUrl: repositories.gitUrl,
      indexReady: repositories.indexReady,
      indexingReason: repositories.indexingReason,
      lastIngestedHash: repositories.lastIngestedHash,
      githubConnectionId: repositories.githubConnectionId,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
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
      githubConnectionId
        ? and(
            eq(repositories.orgId, orgId),
            eq(repositories.githubConnectionId, githubConnectionId),
          )
        : eq(repositories.orgId, orgId),
    )
}

export const listRepositories = async (): Promise<RepositoryWithSearch[]> => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return selectRepositoriesWithZoekt(db, orgId)
}

export const listRepositoriesForGithubConnection = async (
  githubConnectionId: string,
): Promise<RepositoryWithSearch[]> => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return selectRepositoriesWithZoekt(db, orgId, githubConnectionId)
}

/** Repositories linked to this GitHub App connection (`github_connection_id`). */
export async function countRepositoriesForGithubConnection(
  githubConnectionId: string,
): Promise<number> {
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
}

/** Repos linked to a GitHub connection whose gitUrl is not in the allowed set. */
export async function pruneGithubConnectionRepositoriesNotInGitUrls(
  orgId: string,
  githubConnectionId: string,
  allowedGitUrls: Set<string>,
): Promise<void> {
  const orgSlug = requireCurrentOrgSlug()
  const db = getOrgDb()
  const rows = await db
    .select({ id: repositories.id, gitUrl: repositories.gitUrl })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, orgId),
        eq(repositories.githubConnectionId, githubConnectionId),
      ),
    )
  for (const row of rows) {
    if (allowedGitUrls.has(row.gitUrl)) continue
    await withGraphClient({ orgId, orgSlug }, () =>
      deleteRepositoryWithCleanup({ orgId, repositoryId: row.id }),
    )
  }
}

/** Returns repositories for org. Use when orgId is from state (e.g. graph nodes).
 *  Assumes caller has established org DB context. */
export const listRepositoriesForOrg = async (
  orgId: string,
): Promise<RepositoryWithSearch[]> => {
  return selectRepositoriesWithZoekt(getOrgDb(), orgId)
}

export const getRepository = async (
  repositoryId: string,
): Promise<RepositoryWithSearch | null> => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const [row] = await db
    .select({
      id: repositories.id,
      orgId: repositories.orgId,
      name: repositories.name,
      gitUrl: repositories.gitUrl,
      indexReady: repositories.indexReady,
      indexingReason: repositories.indexingReason,
      lastIngestedHash: repositories.lastIngestedHash,
      githubConnectionId: repositories.githubConnectionId,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
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
      and(eq(repositories.id, repositoryId), eq(repositories.orgId, orgId)),
    )
    .limit(1)
  return row ?? null
}

/** For worker/ingestion paths: requires org DB context (`withOrgDbContext`). */
export async function getGithubConnectionIdForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<string | null> {
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
}

/**
 * Marks a repository as mid-ingestion for UI (`indexReady` false + optional reason).
 * Idempotent when already not ready with the same reason.
 *
 * Assumes caller has established org DB context. Cross-org safety is
 * enforced by RLS on repositories (separate PR); the UPDATE targets a PK.
 */
export async function markRepositoryIndexingPending(input: {
  repositoryId: string
  reason: string | null
}) {
  const db = getOrgDb()
  await db
    .update(repositories)
    .set({
      indexReady: false,
      indexingReason: input.reason,
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, input.repositoryId))
}

/** Match GitHub `full_name` for a specific GitHub connection only.
 *  Assumes caller has established org DB context. */
export async function findRepositoryByGithubInstallation(
  orgId: string,
  fullName: string,
  githubConnectionId: string,
) {
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
}

export const createRepository = async (input: {
  name: string
  gitUrl: string
}): Promise<RepositoryWithSearch> => {
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
      })
      .returning()
    if (!repository) return []
    const [checkout] = await tx
      .insert(repositoryCheckouts)
      .values({
        id: checkoutId,
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
}

export const ensureGithubConnectionRepositories = async (
  orgId: string,
  githubConnectionId: string,
  input: Array<{ name: string; gitUrl: string }>,
): Promise<RepositoryWithSearch[]> => {
  if (input.length === 0) return []
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const ensureDefaultCheckout = async (repositoryId: string) => {
      const [existing] = await tx
        .select({ zoektRepoId: repositoryCheckouts.zoektRepoId })
        .from(repositoryCheckouts)
        .where(
          and(
            eq(repositoryCheckouts.repositoryId, repositoryId),
            eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
          ),
        )
        .limit(1)
      if (existing) return existing

      const [created] = await tx
        .insert(repositoryCheckouts)
        .values({
          id: generateObjectId("co"),
          repositoryId,
          ref: "main",
          checkoutKey: DEFAULT_CHECKOUT_KEY,
        })
        .onConflictDoNothing({
          target: [
            repositoryCheckouts.repositoryId,
            repositoryCheckouts.checkoutKey,
          ],
        })
        .returning({ zoektRepoId: repositoryCheckouts.zoektRepoId })
      if (created) return created

      const [afterConflict] = await tx
        .select({ zoektRepoId: repositoryCheckouts.zoektRepoId })
        .from(repositoryCheckouts)
        .where(
          and(
            eq(repositoryCheckouts.repositoryId, repositoryId),
            eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
          ),
        )
        .limit(1)
      if (afterConflict) return afterConflict
      throw new Error("Failed to ensure repository checkout")
    }

    const ensured: RepositoryWithSearch[] = []
    for (const r of input) {
      const [existing] = await tx
        .select()
        .from(repositories)
        .where(
          and(eq(repositories.orgId, orgId), eq(repositories.gitUrl, r.gitUrl)),
        )
        .limit(1)

      const repository =
        existing ??
        (
          await tx
            .insert(repositories)
            .values({
              id: generateObjectId("repo"),
              orgId,
              name: r.name,
              gitUrl: r.gitUrl,
              githubConnectionId,
            })
            .onConflictDoNothing({
              target: [repositories.gitUrl, repositories.orgId],
            })
            .returning()
        )[0]

      const linkedRepository =
        repository && repository.githubConnectionId === githubConnectionId
          ? repository
          : (
              await tx
                .update(repositories)
                .set({
                  githubConnectionId,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(repositories.orgId, orgId),
                    eq(repositories.gitUrl, r.gitUrl),
                  ),
                )
                .returning()
            )[0]

      if (!linkedRepository) {
        throw new Error("Failed to ensure GitHub repository")
      }

      const checkout = await ensureDefaultCheckout(linkedRepository.id)
      ensured.push({
        ...linkedRepository,
        zoektRepoId: checkout.zoektRepoId,
      })
    }
    return ensured
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

export const deleteRepository = async (repositoryId: string) => {
  const orgId = requireCurrentOrgId()
  const orgSlug = requireCurrentOrgSlug()
  return withGraphClient({ orgId, orgSlug }, () =>
    deleteRepositoryWithCleanup({ orgId, repositoryId }),
  )
}
