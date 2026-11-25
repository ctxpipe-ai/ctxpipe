import { and, eq } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { log } from "../../observability/logger.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { gitSourceScopeCommit, gitSourceScopeUrl } from "./providers/git.js"

/**
 * The commit that pins the plain git repository `gitUrl` in the org
 * (CTX-1661), or null. Each ingestion of the repository reads this commit
 * (`resolveRepositoryRef`). The org has one index of each repository, so
 * the pin applies only when each `ok` plain git source of the org that
 * names the repository pins the same commit. When they do not agree, the
 * repository follows its branch, and the disagreement is logged.
 */
export async function plainGitPin(input: {
  orgId: string
  gitUrl: string
}): Promise<string | null> {
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
      pins: commits.size,
    })
  const [commit = null] = commits
  return commits.size === 1 ? commit : null
}
