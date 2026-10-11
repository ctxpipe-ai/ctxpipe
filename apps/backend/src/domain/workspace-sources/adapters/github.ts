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
