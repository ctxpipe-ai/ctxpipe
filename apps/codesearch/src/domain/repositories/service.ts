import { and, eq, sql } from "drizzle-orm"

import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories, repositoryCheckouts } from "../../db/schema.js"
import { DEFAULT_CHECKOUT_KEY } from "./paths.js"

type AccessibleRepository = {
  id: string
  orgId: string
  name: string
  gitUrl: string
  publishedCheckoutKey?: string
}

type IndexableRepository = AccessibleRepository & {
  zoektRepoId: number
  /** A run used the checkout row in the last hour (checkout collection). */
  checkoutUsedRecently?: boolean
  /** The last time a run used the checkout row (checkout collection). */
  checkoutUsedAt?: Date
}

export async function getAccessibleRepository(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  repoId: string,
  orgId: string,
): Promise<AccessibleRepository | null> {
  return withOrgDbContext(db, orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: repositories.id,
        orgId: repositories.orgId,
        name: repositories.name,
        gitUrl: repositories.gitUrl,
        publishedCheckoutKey: publishedRepositoryCheckoutKey(),
      })
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.orgId, orgId)))
      .limit(1)
    if (!row || row.orgId !== orgId) {
      return null
    }
    return row
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
        checkoutUsedRecently: sql<boolean>`${repositoryCheckouts.updatedAt} > now() - interval '1 hour'`,
        checkoutUsedAt: repositoryCheckouts.updatedAt,
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

/** The checkout keys that have a `repository_checkouts` row for the repository. */
export async function listCheckoutKeys(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  repoId: string,
  orgId: string,
): Promise<Set<string>> {
  return withOrgDbContext(db, orgId, async (tx) => {
    const rows = await tx
      .select({ checkoutKey: repositoryCheckouts.checkoutKey })
      .from(repositoryCheckouts)
      .where(
        and(
          eq(repositoryCheckouts.repositoryId, repoId),
          eq(repositoryCheckouts.orgId, orgId),
        ),
      )
    return new Set(rows.map((row) => row.checkoutKey))
  })
}

/** Same published source selection as the backend; workspace snapshots stay explicit. */
export function publishedRepositoryCheckoutKey() {
  return sql<string>`coalesce((select published.checkout_key from repository_checkouts published
    where published.repository_id = repositories.id and published.org_id = repositories.org_id
      and published.checkout_key = 'rev:' || repositories.last_ingested_hash
      and published.commit_sha = repositories.last_ingested_hash), 'default')`
}
