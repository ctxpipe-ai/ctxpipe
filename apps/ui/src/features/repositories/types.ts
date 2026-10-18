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
  | "complete_with_issues"

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

const BADGE_BY_KEY: Record<string, string> = {
  queued: "queued",
  resolving_ref: "resolving",
  index_queue: "indexing",
  cloning: "cloning",
  checking_out: "checking out",
  indexing_search: "indexing",
  detecting_languages: "indexing",
  merging_intelligence: "indexing",
  finalizing: "finalizing",
}

/** Returns the badge word for a given indexing step key (mirrors backend getBadgeWord). */
export function getBadgeWord(key: string): string {
  if (key.startsWith("scip:")) return "indexing"
  return BADGE_BY_KEY[key] ?? "indexing"
}

/**
 * Returns a compact step label like `"finalizing 7/22"` when all three step
 * fields are present, or `null` when step data is unavailable.
 */
export function formatIndexingStepLabel(repo: {
  indexingStep?: number | null
  indexingStepTotal?: number | null
  indexingStepKey?: string | null
}): string | null {
  if (
    repo.indexingStep == null ||
    repo.indexingStepTotal == null ||
    repo.indexingStepKey == null
  ) {
    return null
  }
  return `${getBadgeWord(repo.indexingStepKey)} ${repo.indexingStep}/${repo.indexingStepTotal}`
}
