import type { InferResponseType } from "hono/client"
import type { client } from "@/lib/api"

type ListRepositoriesResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["repositories"]["$get"],
  200
>

export type Repository = ListRepositoriesResponse["items"][number]

export type RepositoryIndexingStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "unindexing"

/** UI-only display labels derived from API status + prior success. */
export type RepositoryStatusDisplay =
  | RepositoryIndexingStatus
  | "out-of-date"
  | "refreshing"

export function getRepositoryIndexingStatus(repo: {
  indexReady?: boolean
  indexingStatus?: RepositoryIndexingStatus | null
}): RepositoryIndexingStatus {
  return repo.indexingStatus ?? (repo.indexReady ? "ready" : "running")
}

export function formatShortCommitHash(hash: string): string {
  return hash.trim().slice(0, 7)
}

export function getRepositoryStatusDisplay(repo: {
  indexReady?: boolean
  indexingStatus?: RepositoryIndexingStatus | null
  lastIngestedHash?: string | null
}): RepositoryStatusDisplay {
  const status = getRepositoryIndexingStatus(repo)
  const hasPriorSuccess = Boolean(repo.lastIngestedHash?.trim())
  if (status === "failed" && hasPriorSuccess) return "out-of-date"
  if (status === "running" && hasPriorSuccess) return "refreshing"
  return status
}
