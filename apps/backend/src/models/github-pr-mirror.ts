import { withOrgDbContext } from "../db/client.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { listLinkedRepositoryPins } from "./workspace-source-state.js"

/**
 * Workspaces in this org whose linked repositories include `gitUrl`. Merged
 * pull requests of that repository are mirrored into each of them.
 */
export async function listGithubPrMirrorWorkspaceIds(input: {
  orgId: string
  gitUrl: string
}): Promise<string[]> {
  // The projection stores linked URLs normalized, so equality is the URL match.
  const gitUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  const pins = await withOrgDbContext(input.orgId, (db) =>
    listLinkedRepositoryPins(db, { orgId: input.orgId }),
  )
  return [
    ...new Set(
      pins.filter((pin) => pin.gitUrl === gitUrl).map((pin) => pin.workspaceId),
    ),
  ].sort()
}
