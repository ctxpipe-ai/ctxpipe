import { and, eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
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
  return withOrgDbContext(db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.orgId, orgId)))
      .limit(1)
    if (!row || row.orgId !== orgId) {
      return null
    }
    return { id: row.id, orgId: row.orgId, name: row.name, gitUrl: row.gitUrl }
  })
}

export async function getIndexableRepository(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  repoId: string,
  orgId: string,
  checkoutKey = DEFAULT_CHECKOUT_KEY,
): Promise<IndexableRepository | null> {
  return withOrgDbContext(db, orgId, async (tx) => {
    const [row] = await tx
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
          eq(repositoryCheckouts.orgId, orgId),
          eq(repositoryCheckouts.checkoutKey, checkoutKey),
        ),
      )
      .where(and(eq(repositories.id, repoId), eq(repositories.orgId, orgId)))
      .limit(1)
    if (!row || row.orgId !== orgId) {
      return null
    }
    return row
  })
}
