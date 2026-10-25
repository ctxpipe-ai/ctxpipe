import {
  formatIndexingStepLabel,
  getRepositoryIndexingStatus,
  type RepositoryIndexingStatus,
} from "./types"

type RepositoryIndexingSummary = {
  totalCount: number
  activeCount: number
  queuedCount: number
  runningCount: number
  failedCount: number
  /**
   * When exactly one active (queued/running) repository has step data,
   * this is its formatted step label (e.g. `"finalizing 7/22"`).
   * Null when there are zero or multiple active repos, or no step data.
   */
  singleActiveStepLabel: string | null
}

export function getRepositoryIndexingSummary(
  repositories: Array<{
    indexReady?: boolean
    indexingStatus?: RepositoryIndexingStatus | null
    indexingStep?: number | null
    indexingStepTotal?: number | null
    indexingStepKey?: string | null
  }>,
): RepositoryIndexingSummary {
  let activeCount = 0
  let queuedCount = 0
  let runningCount = 0
  let failedCount = 0
  let singleActiveRepo: (typeof repositories)[number] | null = null

  for (const repository of repositories) {
    const status = getRepositoryIndexingStatus(repository)
    if (status === "queued" || status === "running") {
      activeCount += 1
      singleActiveRepo = activeCount === 1 ? repository : null
    }
    if (status === "queued") queuedCount += 1
    if (status === "running") runningCount += 1
    if (status === "failed" || status === "complete_with_issues") {
      failedCount += 1
    }
  }

  const singleActiveStepLabel =
    activeCount === 1 && singleActiveRepo
      ? formatIndexingStepLabel(singleActiveRepo)
      : null

  return {
    totalCount: repositories.length,
    activeCount,
    queuedCount,
    runningCount,
    failedCount,
    singleActiveStepLabel,
  }
}
