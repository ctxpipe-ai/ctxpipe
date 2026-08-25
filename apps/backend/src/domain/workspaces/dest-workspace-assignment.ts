import { firstConnectorTarget } from "./migration-cutover.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export type DestWorkspaceRow = {
  id: string
  workspaceRepositoryUrl: string
}

export type DestRepositoryRow = {
  id: string
  gitUrl: string
  createdAt: Date
}

export type DestLinkedRow = {
  id: string
  workspaceId: string
  gitUrl: string
}

export type DestWorkspaceLinkPlan = {
  firstWorkspaceId: string | null
  firstSourceRepositoryId: string | null
  insertLinks: Array<{ workspaceId: string; gitUrl: string }>
  deleteLinkIds: string[]
}

/**
 * Non-target ingested repos link only to the first connector-target Workspace.
 * Sibling Workspace repositories are not auto-linked.
 */
export function planDestWorkspaceLinks(input: {
  workspaces: readonly DestWorkspaceRow[]
  repositories: readonly DestRepositoryRow[]
  connectorTargetRepositoryIds: readonly string[]
  existingLinks: readonly DestLinkedRow[]
  normalizeUrl?: (raw: string) => string
}): DestWorkspaceLinkPlan {
  const normalize = input.normalizeUrl ?? normalizeWorkspaceRepositoryUrl
  const repoById = new Map(input.repositories.map((row) => [row.id, row]))
  const targetRepos = input.connectorTargetRepositoryIds.flatMap((id) => {
    const repo = repoById.get(id)
    return repo ? [repo] : []
  })
  const firstTarget = firstConnectorTarget(targetRepos)
  const workspaceByUrl = new Map(
    input.workspaces.map((row) => [
      normalize(row.workspaceRepositoryUrl),
      row.id,
    ]),
  )
  const firstSourceRepositoryId = firstTarget?.id ?? null
  const firstWorkspaceId = firstTarget
    ? (workspaceByUrl.get(normalize(firstTarget.gitUrl)) ?? null)
    : null
  const workspaceUrls = new Set(workspaceByUrl.keys())
  const targetUrls = new Set(
    targetRepos.map((repo) => normalize(repo.gitUrl)).filter(Boolean),
  )
  const nonTargetUrls = [
    ...new Set(
      input.repositories
        .map((repo) => normalize(repo.gitUrl))
        .filter(
          (url) => url && !workspaceUrls.has(url) && !targetUrls.has(url),
        ),
    ),
  ]
  const wanted = new Set(
    firstWorkspaceId
      ? nonTargetUrls.map((gitUrl) => `${firstWorkspaceId}\0${gitUrl}`)
      : [],
  )
  const deleteLinkIds: string[] = []
  const existingKeys = new Set<string>()
  for (const link of input.existingLinks) {
    const gitUrl = normalize(link.gitUrl)
    const key = `${link.workspaceId}\0${gitUrl}`
    existingKeys.add(key)
    if (!wanted.has(key)) deleteLinkIds.push(link.id)
  }
  const insertLinks =
    firstWorkspaceId == null
      ? []
      : nonTargetUrls
          .filter((gitUrl) => !existingKeys.has(`${firstWorkspaceId}\0${gitUrl}`))
          .map((gitUrl) => ({ workspaceId: firstWorkspaceId, gitUrl }))
  return {
    firstWorkspaceId,
    firstSourceRepositoryId,
    insertLinks,
    deleteLinkIds,
  }
}
