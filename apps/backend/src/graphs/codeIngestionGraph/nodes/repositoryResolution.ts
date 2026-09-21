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
  if (!input.githubConnectionId) return undefined
  const cached = input.cache?.get(input.repository)
  if (input.cache?.has(input.repository)) return cached
  let resolved: string | undefined
  try {
    const row = await findRepositoryByGithubInstallation(
      input.orgId,
      input.repository,
      input.githubConnectionId,
    )
    resolved = row?.id
  } catch {
    resolved = undefined
  }
  input.cache?.set(input.repository, resolved)
  return resolved
}
