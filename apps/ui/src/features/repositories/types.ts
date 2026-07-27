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

export function getRepositoryIndexingStatus(repo: {
  indexReady?: boolean
  indexingStatus?: RepositoryIndexingStatus | null
}): RepositoryIndexingStatus {
  return repo.indexingStatus ?? (repo.indexReady ? "ready" : "running")
}
