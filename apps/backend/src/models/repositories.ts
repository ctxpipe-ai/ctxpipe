import { eq, and } from "drizzle-orm"
import { requireCurrentOrgId } from "src/auth/context.js"
import { repositories } from "src/db/schema/repositories.js"
import { generateObjectId } from "src/lib/id.js"
import { getDb } from "../db/client.js"

export const listRepositories = async () => {
  const orgId = requireCurrentOrgId()
  return getDb().query.repositories.findMany({ where: { orgId: { eq: orgId } } })
}

export const getRepository = async (repositoryId: string) => {
  const orgId = requireCurrentOrgId()
  const repository = await getDb().query.repositories.findFirst({
    where: {
      id: { eq: repositoryId },
      orgId: { eq: orgId },
    },
  })
  return repository
}

export const createRepository = async (input: {
  name: string
  gitUrl: string
}) => {
  const orgId = requireCurrentOrgId()
  const db = getDb()
  const id = generateObjectId("repo")
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
  const db = getDb()

  const repository = await db.query.repositories.findFirst({
    where: {
      id: { eq: repositoryId },
      orgId: { eq: orgId },
    },
  })

  if (!repository) {
    return null
  }

  await db
    .delete(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.orgId, orgId)))

  return repository
}
