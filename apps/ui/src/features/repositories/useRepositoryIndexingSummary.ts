import { queryOptions, useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { pollWhileOk, readApiJson } from "@/lib/api-result"
import {
  formatIndexingStepLabel,
  getRepositoryIndexingStatus,
  type Repository,
  type RepositoryIndexingStatus,
} from "./types"

export type RepositoryIndexingSummary = {
  totalCount: number
  activeCount: number
  queuedCount: number
  runningCount: number
  failedCount: number
  /**
   * When exactly one active (queued/running) repository has step data,
   * this is its formatted step label (e.g. `"embedding 7/22"`).
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

export function repositoriesListOptions(orgSlug: string) {
  return queryOptions({
    queryKey: ["repositories", orgSlug],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      const json = await readApiJson<{ items: Repository[] }>(res, {
        message: "Failed to fetch repositories",
      })
      return json.items
    },
  })
}

export function useRepositoryIndexingSummary(
  orgSlug: string | null,
  options: {
    enabled?: boolean
    pollWhileEmpty?: boolean
  } = {},
) {
  const query = useQuery({
    ...repositoriesListOptions(orgSlug ?? ""),
    enabled: Boolean(orgSlug) && (options.enabled ?? true),
    refetchInterval: (query) => {
      const interval = pollWhileOk(3000)(query)
      if (interval === false) return false
      const repositories = (query.state.data as Repository[] | undefined) ?? []
      const summary = getRepositoryIndexingSummary(repositories)
      return summary.activeCount > 0 ||
        (options.pollWhileEmpty && repositories.length === 0)
        ? interval
        : false
    },
  })

  return {
    repositories: query.data,
    summary: getRepositoryIndexingSummary(query.data ?? []),
    isPending: query.isPending,
    isError: query.isError,
  }
}
