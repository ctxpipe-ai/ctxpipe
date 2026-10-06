import { parseEnv } from "../../config/env.js"
import { resolveRepoReadCoverage } from "../../models/github-installation.js"
import {
  bulkCreateRepositoriesForOrg,
  findRepositoriesByNormalizedGitUrls,
  setRepositoryGithubConnectionId,
} from "../../models/repositories.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import {
  displayNameFromGitUrl,
  normalizeWorkspaceRepositoryUrl,
} from "./slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export function repositoryNameFromGitUrl(gitUrl: string): string {
  const normalized = normalizeWorkspaceRepositoryUrl(gitUrl)
  try {
    const url = new URL(normalized)
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/")
    if (parts.length === 0) return displayNameFromGitUrl(normalized)
    if (url.hostname.toLowerCase() === "github.com" && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`
    }
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname
    return `${host}/${parts.join("/")}`
  } catch {
    // fall through to basename
  }
  return displayNameFromGitUrl(normalized)
}

export async function ensureOrgRepositoryForGitUrl(input: {
  orgId: string
  gitUrl: string
  githubConnectionId?: string | null
}): Promise<{ id: string; created: boolean } | null> {
  const gitUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  if (!gitUrl) return null
  const requestedConnectionId = input.githubConnectionId
  const repoFullName = githubRepoFullNameFromWorkspaceUrl(gitUrl)
  const existing = await findRepositoriesByNormalizedGitUrls([gitUrl])
  // Fail closed: bind only a connection that GitHub confirms can read the repository.
  const coverage =
    requestedConnectionId && repoFullName
      ? await resolveRepoReadCoverage(
          input.orgId,
          parseEnv(process.env as Record<string, string | undefined>),
          { githubConnectionId: requestedConnectionId, repoFullName },
        )
      : "unknown"
  /**
   * Bind a covering connection. Clear a binding only when it is the requested
   * connection and GitHub confirms that it cannot read the repository. A
   * binding that belongs to another connection stays.
   */
  const reconcileBinding = async (repository: {
    id: string
    githubConnectionId: string | null
  }) => {
    if (!requestedConnectionId) return
    const target =
      coverage === "covers"
        ? requestedConnectionId
        : coverage === "foreign" &&
            repository.githubConnectionId === requestedConnectionId
          ? null
          : repository.githubConnectionId
    if (target === repository.githubConnectionId) return
    // The read does not lock the row. Write only if the binding did not change after the read.
    await setRepositoryGithubConnectionId({
      repositoryId: repository.id,
      githubConnectionId: target,
      expectedGithubConnectionId: repository.githubConnectionId,
    })
  }

  if (existing[0]) {
    await reconcileBinding(existing[0])
    return { id: existing[0].id, created: false }
  }

  const created = await bulkCreateRepositoriesForOrg(
    input.orgId,
    [{ name: repositoryNameFromGitUrl(gitUrl), gitUrl }],
    requestedConnectionId && coverage === "covers"
      ? { githubConnectionId: requestedConnectionId }
      : undefined,
  )
  if (created[0]) return { id: created[0].id, created: true }

  const raced = await findRepositoriesByNormalizedGitUrls([gitUrl])
  if (!raced[0]) return null
  await reconcileBinding(raced[0])
  return { id: raced[0].id, created: false }
}

export async function ensureOrgRepositoryAndIngest(input: {
  orgId: string
  gitUrl: string
  githubConnectionId?: string | null
  log: { error: (err: Error) => void }
}): Promise<{ id: string; created: boolean } | null> {
  const repo = await ensureOrgRepositoryForGitUrl(input)
  if (!repo) return null
  await enqueueRepositoryIngestionWorkflow(
    { repositoryId: repo.id, orgId: input.orgId },
    input.log,
  )
  return repo
}
