import type { Env } from "../../../config/env.js"
import {
  listOrgSourceRows,
  recordSourceAccessCheck,
  type WorkspaceSourceRow,
} from "../../../models/workspace-sources.js"
import { ensureOrgRepositoryForGitUrl } from "../../workspaces/ensure-org-repository.js"
import type { SourceAdapter } from "../adapter.js"
import { githubNoAccessDetail } from "../github-sources.js"
import { githubScopeSchema } from "../providers/github.js"

/**
 * The GitHub source adapter (ADR-050). GitHub mirrors no files: hydrate links
 * the repositories of each GitHub source, and the tip check and the index
 * clone them. So the adapter owns no path and fetches nothing.
 *
 * `checkAccess` runs at each projection. It binds the org repository row of
 * each repository to the source's connection when GitHub confirms read
 * access, so the tip check and the index read with that connection's token.
 * It names each repository that the connection cannot read; the row becomes
 * `out_of_access`, and the tip check skips those repositories.
 */
export const githubSourceAdapter: SourceAdapter = {
  provider: "github",
  managedPaths: () => [],
  fetch: async () => [],
  async checkAccess({ orgId, connectionId, scope }) {
    const { repositories } = githubScopeSchema.parse(scope)
    const missing: string[] = []
    for (const name of repositories) {
      // Hydrate runs the projection inside the org context (`withOrgIdContext`).
      const repository = await ensureOrgRepositoryForGitUrl({
        orgId,
        gitUrl: `https://github.com/${name}`,
        githubConnectionId: connectionId,
      })
      if (repository?.coverage === "foreign") missing.push(name)
    }
    return missing.length ? githubNoAccessDetail(missing) : null
  },
}

/** How long the tip check waits before it checks a no-access source again. */
const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * The GitHub sources of an org that are `out_of_access` now. A row last
 * checked more than six hours ago is checked again first, so access that an
 * admin adds to the installation comes back without a new commit. Call it
 * inside the org context (`withOrgIdContext`).
 */
export async function githubSourcesWithoutAccess(input: {
  orgId: string
  env: Env
  now: Date
}): Promise<WorkspaceSourceRow[]> {
  const rows = await listOrgSourceRows({
    orgId: input.orgId,
    provider: "github",
    status: "out_of_access",
  })
  const still: WorkspaceSourceRow[] = []
  for (const row of rows) {
    if (
      !row.connectionId ||
      input.now.getTime() - row.updatedAt.getTime() < RECHECK_AFTER_MS
    ) {
      still.push(row)
      continue
    }
    const detail = await githubSourceAdapter.checkAccess?.({
      orgId: input.orgId,
      connectionId: row.connectionId,
      scope: row.scope,
      env: input.env,
    })
    await recordSourceAccessCheck({
      orgId: input.orgId,
      id: row.id,
      revision: row.revision,
      status: detail ? "out_of_access" : "ok",
      statusDetail: detail ?? null,
    })
    if (detail) still.push({ ...row, statusDetail: detail })
  }
  return still
}
