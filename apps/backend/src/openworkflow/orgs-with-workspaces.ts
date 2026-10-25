import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { listOrgWorkspaces } from "../models/workspaces.js"
import { log } from "../observability/logger.js"

/**
 * The ids of the orgs that have a Workspace, in id order. An org whose
 * Workspaces cannot be read is logged and left out, so one bad org does not
 * stop the others.
 */
export async function listOrgIdsWithWorkspaces(): Promise<string[]> {
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.id)
  const ids: string[] = []
  for (const { id: orgId } of orgs) {
    try {
      // RLS shows the Workspaces of an org only in its own context.
      const workspaces = await withOrgDbContext(orgId, () =>
        listOrgWorkspaces(orgId),
      )
      if (workspaces.length) ids.push(orgId)
    } catch (error) {
      log.error({
        step: "list-orgs-with-workspaces",
        message: `Reading the Workspaces of the org failed: ${String(error)}`,
        orgId,
      })
    }
  }
  return ids
}
