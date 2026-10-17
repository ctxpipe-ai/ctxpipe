/**
 * Final repository status after a source index. Without Zoekt the previous
 * revision stays published; an incomplete SCIP index still publishes, with
 * its issue (main #286 / #371).
 */
export function indexingOutcome(state: {
  searchIndexOk?: boolean
  searchIndexError?: string
  scipIndexOk?: boolean
  scipIndexError?: string
}):
  | { kind: "ready" }
  | { kind: "ready-with-issues"; error: string }
  | { kind: "issues"; error: string } {
  const scipIssue =
    state.scipIndexOk === false
      ? state.scipIndexError?.trim() || "SCIP index unavailable"
      : null
  if (state.searchIndexOk === false)
    return {
      kind: "issues",
      error: [
        state.searchIndexError?.trim() || "Search index unavailable",
        ...(scipIssue ? [scipIssue] : []),
      ].join("; "),
    }
  return scipIssue
    ? { kind: "ready-with-issues", error: scipIssue }
    : { kind: "ready" }
}
