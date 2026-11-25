import { and, eq } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { log } from "../../observability/logger.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { gitSourceScopeCommit, gitSourceScopeUrl } from "./providers/git.js"

/**
 * The pins of the plain git repository `gitUrl` in the org (CTX-1661).
 * `pin` is the commit that each ingestion of the repository reads
 * (`resolveRepositoryRef`, and the re-ingestion), or null when the
 * repository follows its branch. `pinned` holds each commit that an `ok`
 * plain git source of the org pins for the repository.
 *
 * A repository that a GitHub connection reads (`githubConnectionId`) has
 * no pins. The org has one index of each repository, so the pin applies
 * only when each `ok` plain git source of the org that names the
 * repository pins the same commit. When they do not agree, the repository
 * follows its branch, and the disagreement is logged.
 */
export async function plainGitPins(input: {
  orgId: string
  gitUrl: string
  githubConnectionId: string | null
}): Promise<{ pin: string | null; pinned: ReadonlySet<string> }> {
  if (input.githubConnectionId) return { pin: null, pinned: new Set() }
  const url = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ scope: workspaceSources.scope })
      .from(workspaceSources)
      .where(
        and(
          eq(workspaceSources.orgId, input.orgId),
          eq(workspaceSources.provider, "git"),
          eq(workspaceSources.status, "ok"),
        ),
      ),
  )
  const commits = new Set(
    rows
      .filter((row) => {
        const named = gitSourceScopeUrl(row.scope)
        return named !== null && normalizeWorkspaceRepositoryUrl(named) === url
      })
      .map((row) => gitSourceScopeCommit(row.scope)),
  )
  if (commits.size > 1)
    log.warn({
      step: "workspace_sources.git.pin_conflict",
      message:
        "The plain git sources of the repository do not pin the same commit; it follows its branch",
      repositoryUrl: url,
      pins: commits.size,
    })
  const [commit = null] = commits
  return {
    pin: commits.size === 1 ? commit : null,
    pinned: new Set([...commits].filter((item) => item !== null)),
  }
}
