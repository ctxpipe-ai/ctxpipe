import {
  getRepositoryStatusDisplay,
  type Repository,
  type RepositoryStatusDisplay,
} from "./types"

export type GitSourceStatusFilter =
  | "all"
  | "indexed"
  | "indexing"
  | "failed"
  | "pending"

export function gitSourceMatchesQuery(
  name: string,
  url: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return name.toLowerCase().includes(q) || url.toLowerCase().includes(q)
}

export function repositoryMatchesStatusFilter(
  repo: Pick<Repository, "indexReady" | "indexingStatus" | "lastIngestedHash">,
  filter: GitSourceStatusFilter,
): boolean {
  if (filter === "all" || filter === "pending") return filter === "all"
  const display = getRepositoryStatusDisplay(repo)
  return statusDisplayMatchesFilter(display, filter)
}

function statusDisplayMatchesFilter(
  display: RepositoryStatusDisplay,
  filter: GitSourceStatusFilter,
): boolean {
  if (filter === "indexed")
    return display === "ready" || display === "complete_with_issues"
  if (filter === "indexing") {
    return (
      display === "queued" ||
      display === "running" ||
      display === "refreshing" ||
      display === "unindexing"
    )
  }
  if (filter === "failed")
    return (
      display === "failed" ||
      display === "out-of-date" ||
      display === "complete_with_issues"
    )
  return false
}

/** Chip counts must use the same predicate as {@link repositoryMatchesStatusFilter}. */
export function gitSourceFilterCounts(
  repos: Array<
    Pick<Repository, "indexReady" | "indexingStatus" | "lastIngestedHash">
  >,
  pendingCount: number,
): Record<GitSourceStatusFilter, number> {
  const counts: Record<GitSourceStatusFilter, number> = {
    all: repos.length + pendingCount,
    indexed: 0,
    indexing: 0,
    failed: 0,
    pending: pendingCount,
  }
  for (const repo of repos) {
    const display = getRepositoryStatusDisplay(repo)
    if (statusDisplayMatchesFilter(display, "indexed")) counts.indexed += 1
    if (statusDisplayMatchesFilter(display, "indexing")) counts.indexing += 1
    if (statusDisplayMatchesFilter(display, "failed")) counts.failed += 1
  }
  return counts
}
