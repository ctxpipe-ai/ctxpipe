import { requireCurrentOrgId } from "src/auth/context.js"
import { repositories } from "src/db/schema/repositories.js"
import { generateObjectId } from "src/lib/id.js"
import { getDb } from "../db/client.js"

export const listRepositories = async (includeNotReady: boolean) => {
  const orgId = requireCurrentOrgId()
  return getDb().query.repositories.findMany({
    where: includeNotReady
      ? { orgId: { eq: orgId } }
      : { orgId: { eq: orgId }, indexReady: { eq: true } },
  })
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
