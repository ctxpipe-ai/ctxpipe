/**
 * The shared names of the `get_related` ranking (ADR-051 section 6). The
 * knowledge plane ranks the results (`plane-reader.ts`, ADR-068).
 */

export const RELEVANCE_INTENTS = [
  "general",
  "why",
  "ownership",
  "change",
  "dependencies",
  "structure",
  "provenance",
] as const

/**
 * The predicate of the edge from a unit to the `Source` unit that it came
 * from (ADR-050). A `Source` unit has one such edge from each of its units,
 * so it is a hub. A walk of all edges does not follow these edges. Only the
 * `provenance` intent, or `predicates` that name them, walk them.
 */
export const FROM_SOURCE_PREDICATE = "FROM_SOURCE"

/** `PullRequest`, `pull-request` and `pull_request` are one kind. */
export function kindKey(kind: string | null | undefined): string {
  return (kind ?? "").toLowerCase().replace(/[^a-z]/g, "")
}
