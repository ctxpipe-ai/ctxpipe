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

export function getRepositoryIndexingStatus(repo: {
  indexReady?: boolean
  indexingStatus?: string | null
}): RepositoryIndexingStatus {
  if (repo.indexingStatus === "queued") return "queued"
  if (repo.indexingStatus === "running") return "running"
  if (repo.indexingStatus === "ready") return "ready"
  if (repo.indexingStatus === "failed") return "failed"
  return repo.indexReady ? "ready" : "running"
}
