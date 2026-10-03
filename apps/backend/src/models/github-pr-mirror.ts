import { and, eq, isNotNull } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaceLinkedRepositories } from "../db/schema/workspaces.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"

/**
 * Workspaces in this org whose linked repositories include `gitUrl`. Merged
 * pull requests of that repository are mirrored into each of them.
 */
export async function listGithubPrMirrorWorkspaceIds(input: {
  orgId: string
  gitUrl: string
}): Promise<string[]> {
  const gitUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  if (!githubRepoFullNameFromWorkspaceUrl(gitUrl)) return []
  // Hydrate stores linked URLs normalized, so equality is the URL match.
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .selectDistinct({ workspaceId: workspaceLinkedRepositories.workspaceId })
      .from(workspaceLinkedRepositories)
      .where(
        and(
          eq(workspaceLinkedRepositories.orgId, input.orgId),
          eq(workspaceLinkedRepositories.gitUrl, gitUrl),
        ),
      ),
  )
  return rows.map((row) => row.workspaceId).sort()
}

export type OrgGithubRepository = {
  repositoryId: string
  /** GitHub connection that reads this repository. */
  connectionId: string
  /** Lowercase `owner/repo`, so webhook and backfill write the same paths. */
  repository: string
}

/** The org repository row for a GitHub URL carries the connection that can read it. */
export async function findOrgGithubRepository(input: {
  orgId: string
  gitUrl: string
}): Promise<OrgGithubRepository | null> {
  const gitUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  const repository = githubRepoFullNameFromWorkspaceUrl(gitUrl)
  if (!repository) return null
  const rows = await withOrgDbContext(input.orgId, () =>
    getOrgDb()
      .select({
        id: repositories.id,
        gitUrl: repositories.gitUrl,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          isNotNull(repositories.githubConnectionId),
        ),
      )
      .orderBy(repositories.createdAt, repositories.id),
  )
  const row = rows.find(
    (candidate) => normalizeWorkspaceRepositoryUrl(candidate.gitUrl) === gitUrl,
  )
  if (!row?.githubConnectionId) return null
  return {
    repositoryId: row.id,
    connectionId: row.githubConnectionId,
    repository,
  }
}
