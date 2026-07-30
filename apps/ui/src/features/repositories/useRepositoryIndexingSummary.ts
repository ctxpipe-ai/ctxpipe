import { useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"
import {
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
}

export function getRepositoryIndexingSummary(
  repositories: Array<{
    indexReady?: boolean
    indexingStatus?: RepositoryIndexingStatus | null
  }>,
): RepositoryIndexingSummary {
  let activeCount = 0
  let queuedCount = 0
  let runningCount = 0
  let failedCount = 0

  for (const repository of repositories) {
    const status = getRepositoryIndexingStatus(repository)
    if (status === "queued" || status === "running") activeCount += 1
    if (status === "queued") queuedCount += 1
    if (status === "running") runningCount += 1
    if (status === "failed") failedCount += 1
  }

  return {
    totalCount: repositories.length,
    activeCount,
    queuedCount,
    runningCount,
    failedCount,
  }
}

export function useRepositoryIndexingSummary(
  orgSlug: string | null,
  options: {
    enabled?: boolean
    pollWhileEmpty?: boolean
  } = {},
) {
  const query = useQuery({
    queryKey: ["repositories", orgSlug],
    enabled: Boolean(orgSlug) && (options.enabled ?? true),
    queryFn: async () => {
      if (!orgSlug) throw new Error("Missing organisation")
      const res = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as { items: Repository[] }
      return json.items
    },
    refetchInterval: (query) => {
      const repositories = (query.state.data as Repository[] | undefined) ?? []
      const summary = getRepositoryIndexingSummary(repositories)
      return summary.activeCount > 0 ||
        (options.pollWhileEmpty && repositories.length === 0)
        ? 3000
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
