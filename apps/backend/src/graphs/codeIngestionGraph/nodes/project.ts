import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import { projectClaimsToGraph } from "../../../retrieval/services/graphProjection.js"

export type ProjectState = {
  repositoryId: string
  orgId: string
  targetHash: string
  indexedAt?: string
  objectIds?: string[]
  claimIds?: string[]
}

/**
 * Projects claims to FalkorDB. Requires orgSlug from organizations table.
 */
export async function project(state: ProjectState): Promise<void> {
  const { orgId, claimIds = [] } = state
  if (claimIds.length === 0) return

  const orgRows = await withOrgDbContext(orgId, async (db) =>
    db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  const org = orgRows[0]

  const orgSlug = org?.slug
  if (!orgSlug) {
    throw new Error(`Organization slug not found for orgId: ${orgId}`)
  }

  await projectClaimsToGraph(orgId, orgSlug, { claimIds })
}
