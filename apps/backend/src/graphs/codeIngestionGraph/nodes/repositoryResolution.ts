import { withOrgDbContext } from "../../../db/client.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"

/** Per-run cache: GitHub `owner/repo` → repository id (or undefined when not connected). */
export type RepositoryIdCache = Map<string, string | undefined>

/**
 * Resolve a GitHub `owner/repo` name to the org's repository row on the same
 * GitHub connection as the repository being ingested. Undefined when the
 * repository is not connected; callers fall back to name-scoped keys.
 */
export async function resolveSourceRepositoryId(input: {
  orgId: string
  repository: string
  githubConnectionId?: string
  cache?: RepositoryIdCache
}): Promise<string | undefined> {
  const githubConnectionId = input.githubConnectionId
  if (!githubConnectionId) return undefined
  const cached = input.cache?.get(input.repository)
  if (input.cache?.has(input.repository)) return cached
  const row = await withOrgDbContext(input.orgId, () =>
    findRepositoryByGithubInstallation(
      input.orgId,
      input.repository,
      githubConnectionId,
    ),
  )
  const resolved = row?.id
  input.cache?.set(input.repository, resolved)
  return resolved
}
