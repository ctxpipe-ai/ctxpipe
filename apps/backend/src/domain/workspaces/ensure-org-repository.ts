import {
  bulkCreateRepositoriesForOrg,
  findRepositoriesByNormalizedGitUrls,
} from "../../models/repositories.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import {
  displayNameFromGitUrl,
  normalizeWorkspaceRepositoryUrl,
} from "./slug.js"

export function repositoryNameFromGitUrl(gitUrl: string): string {
  const normalized = normalizeWorkspaceRepositoryUrl(gitUrl)
  try {
    const url = new URL(normalized)
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/")
    if (url.hostname.toLowerCase() === "github.com" && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`
    }
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

  const existing = await findRepositoriesByNormalizedGitUrls([gitUrl])
  if (existing[0]) return { id: existing[0].id, created: false }

  const created = await bulkCreateRepositoriesForOrg(
    input.orgId,
    [{ name: repositoryNameFromGitUrl(gitUrl), gitUrl }],
    input.githubConnectionId
      ? { githubConnectionId: input.githubConnectionId }
      : undefined,
  )
  if (created[0]) return { id: created[0].id, created: true }

  const raced = await findRepositoriesByNormalizedGitUrls([gitUrl])
  return raced[0] ? { id: raced[0].id, created: false } : null
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
