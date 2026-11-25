import { and, eq } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { log } from "../../observability/logger.js"
import { resolvePlainGitTip } from "../../services/git/plain-git-remote.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { gitSourceScopeCommit, gitSourceScopeUrl } from "./providers/git.js"

/**
 * The commit that pins the plain git repository `gitUrl` in the org
 * (CTX-1661), or null. Each ingestion of the repository reads this commit:
 * `resolveRepositoryRef`, and {@link plainGitTip} for a re-ingestion. A
 * repository that a GitHub connection reads (`githubConnectionId`) follows
 * its branch. The org has one index of each repository, so the pin applies
 * only when each `ok` plain git source of the org that names the
 * repository pins the same commit. When they do not agree, the repository
 * follows its branch, and the disagreement is logged.
 */
export async function plainGitPin(input: {
  orgId: string
  gitUrl: string
  githubConnectionId: string | null
}): Promise<string | null> {
  if (input.githubConnectionId) return null
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
  return commits.size === 1 ? commit : null
}

/**
 * The commit that an ingestion of the plain git repository `url` reads: the
 * pin of the org ({@link plainGitPin}), else the default-branch tip. Null
 * when the repository has no default branch.
 */
export async function plainGitTip(input: {
  orgId: string
  url: string
}): Promise<{ sha: string } | null> {
  const pin = await plainGitPin({
    orgId: input.orgId,
    gitUrl: input.url,
    githubConnectionId: null,
  })
  return pin ? { sha: pin } : resolvePlainGitTip(input.url)
}
