/**
 * Canonical indexing step catalog.
 *
 * Step keys correspond 1:1 to observable phases within a repository ingestion
 * run. The UI uses these to render a progress badge ("indexing N of M").
 *
 * Badge words:
 *   - "indexing"  — codesearch indexing, SCIP compilation, merge, retraction
 *   - "analyzing" — LLM-driven identification and classification passes
 *   - "ingesting" — embedding / graph sync / finalization passes
 */

/** Non-SCIP base steps in execution order. */
const BASE_STEP_KEYS = [
  "queued",
  "resolving_ref",
  "index_queue",
  "cloning",
  "checking_out",
  "indexing_search",
  "detecting_languages",
  // scip:<lang> steps are inserted here at runtime
  "merging_intelligence",
  "retracting",
  "finding_roots",
  "classifying_packages",
  "identify_api_clients",
  "identify_apis",
  "identify_databases",
  "identify_infrastructure",
  "identify_streams",
  "identify_service_dependencies",
  "identify_libraries",
  "identify_patterns",
  "extract_instruction_units",
  "deduplicating",
  "projecting",
  "embedding",
  "syncing_graph",
  "finalizing",
] as const

export type BaseStepKey = (typeof BASE_STEP_KEYS)[number]

/** A full step key: either a base key or a `scip:<lang>` key. */
export type IndexingStepKey = BaseStepKey | `scip:${string}`

/** Badge word shown in the UI status pill. */
export type BadgeWord = "indexing" | "analyzing" | "ingesting"

const INDEXING_BADGE_KEYS = new Set<string>([
  "indexing_search",
  "detecting_languages",
  "merging_intelligence",
  "retracting",
  // scip: prefix handled separately
])

const ANALYZING_BADGE_KEYS = new Set<string>([
  "finding_roots",
  "classifying_packages",
  "identify_api_clients",
  "identify_apis",
  "identify_databases",
  "identify_infrastructure",
  "identify_streams",
  "identify_service_dependencies",
  "identify_libraries",
  "identify_patterns",
  "extract_instruction_units",
])

/** Insertion index in BASE_STEP_KEYS where SCIP language steps are spliced. */
const SCIP_INSERT_AFTER = BASE_STEP_KEYS.indexOf("detecting_languages")

/**
 * Returns the badge word for a given step key.
 * - `scip:<lang>` → "indexing"
 * - identify_* / classifying / extract / find_roots → "analyzing"
 * - queued / cloning / embedding / syncing / finalizing etc. → "ingesting"
 */
export function getBadgeWord(key: IndexingStepKey): BadgeWord {
  if (key.startsWith("scip:") || INDEXING_BADGE_KEYS.has(key)) return "indexing"
  if (ANALYZING_BADGE_KEYS.has(key)) return "analyzing"
  return "ingesting"
}

/**
 * Builds an ordered list of step keys for a run, inserting `scip:<lang>` keys
 * after `detecting_languages`.
 */
export function buildIndexingChecklist(scipLanguages: string[] = []): IndexingStepKey[] {
  const scipKeys: IndexingStepKey[] = scipLanguages.map((l) => `scip:${l}`)
  const result: IndexingStepKey[] = []
  for (let i = 0; i < BASE_STEP_KEYS.length; i++) {
    result.push(BASE_STEP_KEYS[i] as IndexingStepKey)
    if (i === SCIP_INSERT_AFTER) {
      result.push(...scipKeys)
    }
  }
  return result
}

export interface IndexingStepResolution {
  /** 1-based step index (position in the checklist). */
  step: number
  /** Total steps for this run. */
  total: number
  /** Canonical step key. */
  key: IndexingStepKey
  /** Badge word for this step. */
  badgeWord: BadgeWord
}

/**
 * Resolves a step key to its numeric position and badge word within a run.
 * Returns `null` when the key is not found in the checklist (unknown/obsolete key).
 */
export function resolveIndexingStep(
  key: IndexingStepKey,
  scipLanguages: string[] = [],
): IndexingStepResolution | null {
  const checklist = buildIndexingChecklist(scipLanguages)
  const idx = checklist.indexOf(key)
  if (idx === -1) return null
  return {
    step: idx + 1,
    total: checklist.length,
    key,
    badgeWord: getBadgeWord(key),
  }
}
