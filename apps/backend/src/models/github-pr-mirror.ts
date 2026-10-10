import { and, eq } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { workspaceLinkedRepositories } from "../db/schema/workspaces.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"

/**
 * Workspaces in this org whose linked repositories include `gitUrl`. Merged
 * pull requests of that repository are mirrored into each of them.
 */
export async function listGithubPrMirrorWorkspaceIds(input: {
  orgId: string
  gitUrl: string
}): Promise<string[]> {
  // Hydrate stores linked URLs normalized, so equality is the URL match.
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .selectDistinct({ workspaceId: workspaceLinkedRepositories.workspaceId })
      .from(workspaceLinkedRepositories)
      .where(
        and(
          eq(workspaceLinkedRepositories.orgId, input.orgId),
          eq(
            workspaceLinkedRepositories.gitUrl,
            normalizeWorkspaceRepositoryUrl(input.gitUrl),
          ),
        ),
      ),
  )
  return rows.map((row) => row.workspaceId).sort()
}
