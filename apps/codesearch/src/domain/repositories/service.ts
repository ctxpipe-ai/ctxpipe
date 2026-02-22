import { eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { repositories } from "../../db/schema.js"

export type AccessibleRepository = {
  id: string
  orgId: string
  gitUrl: string
}

export type IndexableRepository = AccessibleRepository & {
  zoektRepoId: number
  name: string
}

export async function getAccessibleRepository(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  repoId: string,
  orgId: string,
): Promise<AccessibleRepository | null> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .limit(1)
  if (!row || row.orgId !== orgId) {
    return null
  }
  return { id: row.id, orgId: row.orgId, gitUrl: row.gitUrl }
}

export async function getIndexableRepository(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  repoId: string,
  orgId: string,
): Promise<IndexableRepository | null> {
  const [row] = await db
    .select({
      id: repositories.id,
      orgId: repositories.orgId,
      gitUrl: repositories.gitUrl,
      zoektRepoId: repositories.zoektRepoId,
      name: repositories.name,
    })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .limit(1)
  if (!row || row.orgId !== orgId) {
    return null
  }
  return row
}
