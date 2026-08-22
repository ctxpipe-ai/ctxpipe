export type HydratePhaseRecord = {
  url: string
  sha: string
  embeddings: boolean
  graph: boolean
  remainders: boolean
}

export type PendingHydratePhases = {
  postgres: boolean
  embeddings: boolean
  graph: boolean
  index: boolean
  remainders: boolean
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

export function hydratePostgresIsComplete(input: {
  activeProjectionUrl: string | null
  activeProjectionSha: string | null
  desiredUrl: string
  desiredSha: string
}): boolean {
  return (
    input.activeProjectionUrl === input.desiredUrl &&
    input.activeProjectionSha === input.desiredSha
  )
}

export function pendingHydratePhases(input: {
  desiredUrl: string
  desiredSha: string
  activeProjectionUrl: string | null
  activeProjectionSha: string | null
  indexedSha: string | null
  phases: HydratePhaseRecord | null
}): PendingHydratePhases {
  const postgres = !hydratePostgresIsComplete(input)
  const phaseMatches =
    input.phases?.url === input.desiredUrl &&
    input.phases?.sha === input.desiredSha
  return {
    postgres,
    embeddings: postgres || !phaseMatches || !input.phases?.embeddings,
    graph: postgres || !phaseMatches || !input.phases?.graph,
    index: input.indexedSha !== input.desiredSha,
    remainders: postgres || !phaseMatches || !input.phases?.remainders,
  }
}

export function hydrateHasPendingWork(pending: PendingHydratePhases): boolean {
  return (
    pending.postgres ||
    pending.embeddings ||
    pending.graph ||
    pending.index ||
    pending.remainders
  )
}

export function initialHydratePhases(input: {
  url: string
  sha: string
}): HydratePhaseRecord {
  return {
    url: input.url,
    sha: input.sha,
    embeddings: false,
    graph: false,
    remainders: false,
  }
}

export function markHydratePhase(
  phases: HydratePhaseRecord,
  phase: "embeddings" | "graph" | "remainders",
): HydratePhaseRecord {
  return { ...phases, [phase]: true }
}
