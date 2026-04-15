import { and, eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { repositories, repositoryCheckouts } from "../../db/schema.js"
import { DEFAULT_CHECKOUT_KEY } from "./paths.js"

export type AccessibleRepository = {
  id: string
  orgId: string
  name: string
  gitUrl: string
}

export type IndexableRepository = AccessibleRepository & {
  zoektRepoId: number
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
  return { id: row.id, orgId: row.orgId, name: row.name, gitUrl: row.gitUrl }
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
      zoektRepoId: repositoryCheckouts.zoektRepoId,
      name: repositories.name,
    })
    .from(repositories)
    .innerJoin(
      repositoryCheckouts,
      and(
        eq(repositoryCheckouts.repositoryId, repositories.id),
        eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
      ),
    )
    .where(eq(repositories.id, repoId))
    .limit(1)
  if (!row || row.orgId !== orgId) {
    return null
  }
  return row
}
