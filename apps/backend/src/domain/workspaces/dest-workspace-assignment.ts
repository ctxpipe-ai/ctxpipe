import { firstConnectorTarget } from "./dest-workspace-first.js"
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
}

/**
 * One-time migration plan: a non-target ingested repository that no Workspace
 * links yet is linked to the first connector-target Workspace. Sibling
 * Workspace repositories are not auto-linked. The plan never removes a link:
 * after the migration, hydrate of each Workspace owns its links.
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
  const linkedUrls = new Set(
    input.existingLinks.map((link) => normalize(link.gitUrl)),
  )
  const insertLinks =
    firstWorkspaceId == null
      ? []
      : [
          ...new Set(
            input.repositories
              .map((repo) => normalize(repo.gitUrl))
              .filter(
                (url) =>
                  url &&
                  !workspaceUrls.has(url) &&
                  !targetUrls.has(url) &&
                  !linkedUrls.has(url),
              ),
          ),
        ].map((gitUrl) => ({ workspaceId: firstWorkspaceId, gitUrl }))
  return {
    firstWorkspaceId,
    firstSourceRepositoryId,
    insertLinks,
  }
}
