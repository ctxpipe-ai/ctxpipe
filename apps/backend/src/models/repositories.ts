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

/** Returns repositories for org. Use when orgId is from state (e.g. graph nodes). */
export const listRepositoriesForOrg = async (orgId: string) => {
  return withOrgDbContext(orgId, async (db) =>
    db.query.repositories.findMany({ where: { orgId: { eq: orgId } } }),
  )
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
