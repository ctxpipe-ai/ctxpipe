import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { workspaceLinkedRepositories } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { orgSql } from "../models/workspace-sql.js"

export async function insertWorkspaceLinks(
  links: Array<{ workspaceId: string; gitUrl: string }>,
): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    for (const link of links) {
      await getOrgDb()
        .insert(workspaceLinkedRepositories)
        .values({ id: generateObjectId("wlr"), orgId, ...link })
        .onConflictDoNothing()
    }
  })
}
