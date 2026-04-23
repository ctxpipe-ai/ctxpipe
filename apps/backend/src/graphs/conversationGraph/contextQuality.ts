import type { ConversationGraphState } from "./state.js"

export type RepositoryIndexRow = { name: string; indexReady: boolean }

/**
 * Machine-readable flags for the conversation advisor. Lets the model refuse
 * confident project-level answers when indexing or retrieval is incomplete.
 */
export function formatContextQualityFlags(params: {
  repositories: RepositoryIndexRow[]
  /** True when this turn's retrieval context includes at least one hydrated claim with evidence. */
  hasHydratedClaimsInContext: boolean
  state: Pick<
    ConversationGraphState,
    "candidates" | "claimAggregationResults" | "currentProjectName"
  >
}): string {
  const { repositories, state, hasHydratedClaimsInContext } = params
  const namesNotReady = repositories
    .filter((r) => !r.indexReady)
    .map((r) => r.name)
  const namesReady = repositories
    .filter((r) => r.indexReady)
    .map((r) => r.name)

  const hasCandidates = (state.candidates?.length ?? 0) > 0
  const hasFleetPatterns = (state.claimAggregationResults?.length ?? 0) > 0
  const notEnoughSignal =
    !hasCandidates && !hasFleetPatterns && !hasHydratedClaimsInContext

  const project = state.currentProjectName?.trim()
  const projectLikelyRepo =
    project &&
    project !== "unknown" &&
    repositories.some((r) => r.name === project)

  const lines = [
    "CONTEXT_QUALITY_FLAGS (trust these over any assumption about coverage):",
    `- repositories_total: ${repositories.length}`,
    `- repository_index_ready_count: ${namesReady.length}`,
    `- repository_index_not_ready_count: ${namesNotReady.length}`,
    `- repository_names_index_not_ready: ${namesNotReady.length ? namesNotReady.join(", ") : "(none)"}`,
    `- repository_names_index_ready: ${namesReady.length ? namesReady.join(", ") : "(none)"}`,
    `- pre_retrieval_signal: ${notEnoughSignal ? "none" : "some"}`,
    `- pre_retrieval_has_candidates: ${hasCandidates}`,
    `- pre_retrieval_has_fleet_patterns: ${hasFleetPatterns}`,
    `- context_includes_hydrated_claims_with_evidence: ${hasHydratedClaimsInContext}`,
    `- current_project_name_matches_repository_row: ${projectLikelyRepo ? "true" : "false"}`,
  ]

  if (namesNotReady.length > 0) {
    lines.push(
      "- indexing_status: at_least_one_repository_not_fully_indexed (index_ready is false for the names above; graph and search may be partial or empty)",
    )
  } else if (repositories.length === 0) {
    lines.push(
      "- indexing_status: no_repositories_registered_for_org (no codebase attached)",
    )
  } else {
    lines.push("- indexing_status: all_listed_repositories_marked_index_ready")
  }

  return lines.join("\n")
}
