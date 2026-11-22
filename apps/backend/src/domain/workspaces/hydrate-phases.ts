import type { HydrateSkip } from "./hydrate.js"
import type { DerivedStoreResult, WorkspaceRevision } from "./revision.js"

export type HydratePhaseRecord = {
  url: string
  sha: string
  /** Committed files that this projection skipped. Each hydrate commit replaces the list. */
  skipped?: HydrateSkip[]
  embeddings: boolean
  embeddingError?: string
  revision?: WorkspaceRevision
  publishedIndex?: WorkspaceRevision | null
  graph?: DerivedPhaseRecord
  index?: DerivedPhaseRecord
}

/**
 * The result of a derived phase of one revision. `failure` is the first
 * failure of this revision since its last success: a retry keeps it while the
 * phase is pending again, so the tip check can space out its retries.
 */
export type DerivedPhaseRecord = {
  revision: WorkspaceRevision
  result: DerivedStoreResult
  failure?: { message: string; at: string }
}

/** Git SHAs are hex; ISO timestamps and calendar dates are not. */
export function looksLikeGitSha(value: string): boolean {
  return /^[0-9a-f]{6,64}$/i.test(value.trim())
}

/**
 * True when a recorded `valid_from` is empty or a Git SHA: the claim then
 * takes the time of its file (`effectiveValidFrom`).
 */
export function takesIntroducingTime(recorded: string | null): boolean {
  const value = recorded?.trim() ?? ""
  return !value || looksLikeGitSha(value)
}

/**
 * The `valid_from` of a claim: its recorded time, else the source time of
 * its file (`sourceTime`, CTX-1516), else the time of the commit that
 * introduced the file.
 */
export function effectiveValidFrom(input: {
  recorded: string | null
  sourceTime?: string | null
  introducingCommitTimestamp: string | null
}): string | null {
  if (!takesIntroducingTime(input.recorded))
    return input.recorded?.trim() ?? null
  return input.sourceTime ?? input.introducingCommitTimestamp
}

/** A non-time value is no bound. A time without an offset uses UTC. */
export function normalizeValidityBound(value: string | null): string | null {
  const raw = value?.trim()
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null
  const utc =
    raw.length > 10 && !/(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw.slice(10))
      ? `${raw}Z`
      : raw
  const time = new Date(utc)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

export function initialHydratePhases(input: {
  url: string
  sha: string
  revision?: WorkspaceRevision
}): HydratePhaseRecord {
  return {
    url: input.url,
    sha: input.sha,
    embeddings: false,
    ...(input.revision ? { revision: input.revision } : {}),
  }
}
