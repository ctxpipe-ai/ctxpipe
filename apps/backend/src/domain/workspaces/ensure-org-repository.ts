import { getGithubInstallationByConnectionId } from "../../models/github-installation.js"
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

/**
 * The connection to bind, `null` when the requested installation cannot cover
 * the repository (a public repository of another GitHub account, read
 * anonymously), or `undefined` when no connection was requested.
 */
async function bindableConnectionId(input: {
  orgId: string
  gitUrl: string
  githubConnectionId?: string | null
}): Promise<string | null | undefined> {
  if (!input.githubConnectionId) return undefined
  const owner = githubRepoFullNameFromWorkspaceUrl(input.gitUrl)
    ?.split("/")[0]
    ?.toLowerCase()
  const account = (
    await getGithubInstallationByConnectionId(
      input.orgId,
      input.githubConnectionId,
    )
  )?.accountSlug?.toLowerCase()
  return owner && account && owner !== account ? null : input.githubConnectionId
}

export async function ensureOrgRepositoryForGitUrl(input: {
  orgId: string
  gitUrl: string
  githubConnectionId?: string | null
}): Promise<{ id: string; created: boolean } | null> {
  const gitUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  if (!gitUrl) return null
  const githubConnectionId = await bindableConnectionId({ ...input, gitUrl })

  const existing = await findRepositoriesByNormalizedGitUrls([gitUrl])
  if (existing[0]) {
    if (githubConnectionId !== undefined) {
      await setRepositoryGithubConnectionId({
        repositoryId: existing[0].id,
        githubConnectionId,
      })
    }
    return { id: existing[0].id, created: false }
  }

  const created = await bulkCreateRepositoriesForOrg(
    input.orgId,
    [{ name: repositoryNameFromGitUrl(gitUrl), gitUrl }],
    githubConnectionId ? { githubConnectionId } : undefined,
  )
  if (created[0]) return { id: created[0].id, created: true }

  const raced = await findRepositoriesByNormalizedGitUrls([gitUrl])
  if (!raced[0]) return null
  if (githubConnectionId !== undefined) {
    await setRepositoryGithubConnectionId({
      repositoryId: raced[0].id,
      githubConnectionId,
    })
  }
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
