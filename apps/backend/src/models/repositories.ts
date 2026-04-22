import { and, eq } from "drizzle-orm"
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
      githubInstallationId: repositories.githubInstallationId,
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
    .where(eq(repositories.orgId, orgId))
}

export const listRepositories = async (): Promise<RepositoryWithSearch[]> => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return selectRepositoriesWithZoekt(db, orgId)
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
      githubInstallationId: repositories.githubInstallationId,
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

/** Match GitHub `full_name` for a specific installation only.
 *  Assumes caller has established org DB context. */
export async function findRepositoryByGithubInstallation(
  orgId: string,
  fullName: string,
  githubInstallationRowId: string,
) {
  const db = getOrgDb()
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, orgId),
        eq(repositories.name, fullName),
        eq(repositories.githubInstallationId, githubInstallationRowId),
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

/**
 * Insert multiple repositories in a single query. Skips repos that already
 * exist (by gitUrl + orgId) via ON CONFLICT DO NOTHING. Returns only the newly created rows.
 * Must be called from a context where getOrgDb() is set (request middleware or inside withOrgDbContext).
 */
async function bulkCreateRepositoriesWithDb(
  orgId: string,
  input: Array<{ name: string; gitUrl: string }>,
  opts?: { githubInstallationId: string },
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
          githubInstallationId: opts?.githubInstallationId,
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
  opts?: { githubInstallationId: string },
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
