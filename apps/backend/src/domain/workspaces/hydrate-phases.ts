import type { DerivedStoreResult, WorkspaceRevision } from "./revision.js"

export type HydratePhaseRecord = {
  url: string
  sha: string
  embeddings: boolean
  embeddingError?: string
  revision?: WorkspaceRevision
  publishedIndex?: WorkspaceRevision | null
  index?: { revision: WorkspaceRevision; result: DerivedStoreResult }
}

/** Git SHAs are hex; ISO timestamps and calendar dates are not. */
export function looksLikeGitSha(value: string): boolean {
  return /^[0-9a-f]{6,40}$/i.test(value.trim())
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
