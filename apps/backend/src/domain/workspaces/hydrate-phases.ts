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

export function effectiveValidFrom(input: {
  recorded: string | null
  introducingCommitTimestamp: string | null
}): string | null {
  const recorded = input.recorded?.trim() ?? ""
  if (recorded && !looksLikeGitSha(recorded)) return recorded
  return input.introducingCommitTimestamp
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
