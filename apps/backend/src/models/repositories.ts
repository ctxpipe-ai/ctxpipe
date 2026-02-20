import { repositories } from "src/db/schema/repositories.js"
import { generateObjectId } from "src/lib/id.js"
import { getDb } from "../db/client.js"

const MOCK_ORG_ID = "org_mock123"

export const listRepositories = async (includeNotReady: boolean) => {
  return getDb().query.repositories.findMany({
    where: includeNotReady
      ? { orgId: { eq: MOCK_ORG_ID } }
      : { orgId: { eq: MOCK_ORG_ID }, indexReady: { eq: true } },
  })
}

export const getRepository = async (repositoryId: string) => {
  const repository = await getDb().query.repositories.findFirst({
    where: {
      id: { eq: repositoryId },
      orgId: { eq: MOCK_ORG_ID },
    },
  })
  return repository
}

export const createRepository = async (input: {
  name: string
  gitUrl: string
}) => {
  const db = getDb()
  const id = generateObjectId("repo")
  const [repository] = await db
    .insert(repositories)
    .values({
      id,
      orgId: MOCK_ORG_ID,
      name: input.name,
      gitUrl: input.gitUrl,
    })
    .returning()

  if (repository) return repository
  throw new Error("Failed to create repository")
}
