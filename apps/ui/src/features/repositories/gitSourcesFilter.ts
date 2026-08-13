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
  if (filter === "indexed") return display === "ready"
  if (filter === "indexing") {
    return (
      display === "queued" ||
      display === "running" ||
      display === "refreshing" ||
      display === "unindexing"
    )
  }
  if (filter === "failed")
    return display === "failed" || display === "out-of-date"
  return false
}
