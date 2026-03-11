import { and, eq } from "drizzle-orm"
import { requireCurrentOrgId } from "src/auth/context.js"
import { repositories } from "src/db/schema/repositories.js"
import { generateObjectId } from "src/lib/id.js"
import { getOrgDb, withOrgDbContext } from "../db/client.js"

export const listRepositories = async () => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.repositories.findMany({ where: { orgId: { eq: orgId } } })
}

export const getRepository = async (repositoryId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.repositories.findFirst({
    where: {
      id: { eq: repositoryId },
      orgId: { eq: orgId },
    },
  })
}

export const createRepository = async (input: {
  name: string
  gitUrl: string
}) => {
  const orgId = requireCurrentOrgId()
  const id = generateObjectId("repo")
  const db = getOrgDb()
  const [repository] = await db
    .insert(repositories)
    .values({
      id,
      orgId: orgId,
      name: input.name,
      gitUrl: input.gitUrl,
    })
    .returning()

  if (repository) return repository
  throw new Error("Failed to create repository")
}

/**
 * Insert multiple repositories in a single query. Skips repos that already
 * exist (by gitUrl + orgId) via ON CONFLICT DO NOTHING. Returns only the newly created rows.
 * Must be called from a context where getOrgDb() is set (request middleware or inside withOrgDbContext).
 */
function bulkCreateRepositoriesWithDb(
  orgId: string,
  input: Array<{ name: string; gitUrl: string }>,
  opts?: { githubInstallationId: string },
) {
  if (input.length === 0) return Promise.resolve([])
  const db = getOrgDb()
  const values = input.map((r) => ({
    id: generateObjectId("repo"),
    orgId,
    name: r.name,
    gitUrl: r.gitUrl,
    githubInstallationId: opts?.githubInstallationId,
  }))
  return db
    .insert(repositories)
    .values(values)
    .onConflictDoNothing({ target: [repositories.gitUrl, repositories.orgId] })
    .returning()
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
  return withOrgDbContext(orgId, () => bulkCreateRepositoriesWithDb(orgId, input, opts))
}

export const deleteRepository = async (repositoryId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const result = await db
    .delete(repositories)
    .where(
      and(eq(repositories.id, repositoryId), eq(repositories.orgId, orgId)),
    )

  return result.rowCount && result.rowCount > 0
}
