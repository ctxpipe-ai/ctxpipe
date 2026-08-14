export type SavedGithubRepo = {
  name: string
  gitUrl: string
}

export type GithubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
}

export type SelectedGithubRepo = {
  id?: number
  full_name: string
  name: string
  clone_url: string
}

/** Compare GitHub clone URLs without a trailing `.git` or case differences. */
export function githubCloneUrlKey(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase()
}

export function matchSavedRepoIds(
  savedGitUrls: Iterable<string>,
  githubRepos: readonly GithubRepoItem[],
): Set<number> {
  const saved = new Set(Array.from(savedGitUrls, githubCloneUrlKey))
  const matched = new Set<number>()
  for (const repo of githubRepos) {
    if (saved.has(githubCloneUrlKey(repo.clone_url))) matched.add(repo.id)
  }
  return matched
}

export function unmatchedSavedRepos(
  savedRepos: readonly SavedGithubRepo[],
  githubRepos: readonly GithubRepoItem[],
): SavedGithubRepo[] {
  const loaded = new Set(
    githubRepos.map((repo) => githubCloneUrlKey(repo.clone_url)),
  )
  return savedRepos.filter(
    (repo) => !loaded.has(githubCloneUrlKey(repo.gitUrl)),
  )
}

const MAX_INSTALLATION_PAGES = 50

export async function collectInstallationRepoPages(
  fetchPage: (page: number) => Promise<{
    repositories: GithubRepoItem[]
    hasMore: boolean
    repositorySelection: string
  }>,
): Promise<{
  repositories: GithubRepoItem[]
  repositorySelection: string
}> {
  const repositories: GithubRepoItem[] = []
  let repositorySelection = "selected"
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
    const result = await fetchPage(page)
    repositorySelection = result.repositorySelection
    repositories.push(...result.repositories)
    if (!result.hasMore) break
  }
  return { repositories, repositorySelection }
}

export function selectedCloneUrlKeys(
  githubRepos: readonly GithubRepoItem[],
  selectedIds: ReadonlySet<number>,
): Set<string> {
  const keys = new Set<string>()
  for (const repo of githubRepos) {
    if (selectedIds.has(repo.id)) keys.add(githubCloneUrlKey(repo.clone_url))
  }
  return keys
}

export function countSelectionDelta(args: {
  savedGitUrls: Iterable<string>
  selectedCloneUrls: Iterable<string>
}): { keptCount: number; addedCount: number; removedCount: number } {
  const saved = new Set(Array.from(args.savedGitUrls, githubCloneUrlKey))
  const selected = new Set(
    Array.from(args.selectedCloneUrls, githubCloneUrlKey),
  )
  let keptCount = 0
  let addedCount = 0
  for (const url of selected) {
    if (saved.has(url)) keptCount += 1
    else addedCount += 1
  }
  let removedCount = 0
  for (const url of saved) {
    if (!selected.has(url)) removedCount += 1
  }
  return { keptCount, addedCount, removedCount }
}

export function describeSelectionDelta(delta: {
  keptCount: number
  addedCount: number
  removedCount: number
}): string {
  const parts = [`${delta.keptCount} already indexed`]
  if (delta.addedCount > 0) parts.push(`${delta.addedCount} added`)
  if (delta.removedCount > 0) parts.push(`${delta.removedCount} removed`)
  return parts.join(" · ")
}

export function buildSelectedRepositories(args: {
  githubRepos: readonly GithubRepoItem[]
  selectedIds: ReadonlySet<number>
  unmatchedSaved: readonly SavedGithubRepo[]
}): SelectedGithubRepo[] {
  const fromGithub = args.githubRepos.filter((repo) =>
    args.selectedIds.has(repo.id),
  )

  const selected: SelectedGithubRepo[] = fromGithub.map((repo) => ({
    id: repo.id,
    full_name: repo.full_name,
    name: repo.name,
    clone_url: repo.clone_url,
  }))

  for (const saved of args.unmatchedSaved) {
    selected.push({
      full_name: saved.name,
      name: saved.name,
      clone_url: saved.gitUrl,
    })
  }
  return selected
}
