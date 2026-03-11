import { and, eq, inArray } from "drizzle-orm"
import { requireCurrentOrgId } from "src/auth/context.js"
import { repositories } from "src/db/schema/repositories.js"
import { generateObjectId } from "src/lib/id.js"
import { getOrgDb } from "../db/client.js"

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
 * exist (by gitUrl + orgId). Returns only the newly created rows.
 */
export const bulkCreateRepositories = async (
  input: Array<{ name: string; gitUrl: string }>,
  opts?: { githubInstallationId: string },
) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  if (input.length === 0) return []
  const gitUrls = input.map((r) => r.gitUrl)
  const existing = await db
    .select({ gitUrl: repositories.gitUrl })
    .from(repositories)
    .where(
      and(eq(repositories.orgId, orgId), inArray(repositories.gitUrl, gitUrls)),
    )
  const existingUrls = new Set(existing.map((r) => r.gitUrl))
  const toInsert = input.filter((r) => !existingUrls.has(r.gitUrl))
  if (toInsert.length === 0) return []
  const values = toInsert.map((r) => ({
    id: generateObjectId("repo"),
    orgId,
    name: r.name,
    gitUrl: r.gitUrl,
    githubInstallationId: opts?.githubInstallationId,
  }))
  const created = await db
    .insert(repositories)
    .values(values)
    .returning()
  return created
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
