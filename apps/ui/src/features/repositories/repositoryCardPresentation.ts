import {
  formatIndexingStepLabel,
  getRepositoryIndexingStatus,
  getRepositoryStatusDisplay,
  type Repository,
  type RepositoryStatusDisplay,
} from "./types"

export type RepositoryCardPresentation = {
  displayStatus: RepositoryStatusDisplay
  issuesDetail: string | null
  failedDetail: string | null
  outOfDateDetail: {
    lastIngestedHash: string
    lastIngestedAt?: string | null
    indexingError?: string | null
  } | null
  showRetryIndexing: boolean
  queryable: boolean
  indexingDetail: string | null
}

export function repositoryCardPresentation(
  repo: Pick<
    Repository,
    | "indexReady"
    | "indexingStatus"
    | "indexingError"
    | "indexingReason"
    | "indexingStep"
    | "indexingStepTotal"
    | "indexingStepKey"
    | "lastIngestedHash"
    | "lastIngestedAt"
  >,
): RepositoryCardPresentation {
  const indexingStatus = getRepositoryIndexingStatus(repo)
  const displayStatus = getRepositoryStatusDisplay(repo)
  const stepLabel =
    displayStatus === "queued" ||
    displayStatus === "running" ||
    displayStatus === "refreshing"
      ? formatIndexingStepLabel(repo)
      : null
  const indexingDetail =
    stepLabel ??
    (displayStatus === "running" && repo.indexingReason === "merge"
      ? "indexing merge"
      : displayStatus === "running" && repo.indexingReason === "push"
        ? "indexing recent changes"
        : null)
  return {
    displayStatus,
    issuesDetail:
      displayStatus === "complete_with_issues"
        ? repo.indexingError?.trim() || null
        : null,
    failedDetail:
      displayStatus === "failed" ? repo.indexingError?.trim() || null : null,
    outOfDateDetail:
      displayStatus === "out-of-date" && repo.lastIngestedHash
        ? {
            lastIngestedHash: repo.lastIngestedHash,
            lastIngestedAt: repo.lastIngestedAt,
            indexingError: repo.indexingError,
          }
        : null,
    showRetryIndexing:
      indexingStatus === "failed" || indexingStatus === "complete_with_issues",
    queryable:
      displayStatus === "ready" || displayStatus === "complete_with_issues",
    indexingDetail,
  }
}
