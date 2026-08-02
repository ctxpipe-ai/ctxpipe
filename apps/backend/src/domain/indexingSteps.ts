/**
 * Canonical indexing step catalog for repository ingestion progress (UI x/n).
 *
 * Badge words are short UI labels; SCIP language detail stays in logs only.
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
export type BadgeWord =
  | "queued"
  | "resolving"
  | "waiting"
  | "cloning"
  | "checking out"
  | "indexing"
  | "updating"
  | "finding packages"
  | "classifying"
  | "analyzing"
  | "deduplicating"
  | "projecting"
  | "embedding"
  | "syncing"
  | "finalizing"

const BADGE_BY_BASE_KEY: Record<BaseStepKey, BadgeWord> = {
  queued: "queued",
  resolving_ref: "resolving",
  index_queue: "waiting",
  cloning: "cloning",
  checking_out: "checking out",
  indexing_search: "indexing",
  detecting_languages: "indexing",
  merging_intelligence: "indexing",
  retracting: "updating",
  finding_roots: "finding packages",
  classifying_packages: "classifying",
  identify_api_clients: "analyzing",
  identify_apis: "analyzing",
  identify_databases: "analyzing",
  identify_infrastructure: "analyzing",
  identify_streams: "analyzing",
  identify_service_dependencies: "analyzing",
  identify_libraries: "analyzing",
  identify_patterns: "analyzing",
  extract_instruction_units: "analyzing",
  deduplicating: "deduplicating",
  projecting: "projecting",
  embedding: "embedding",
  syncing_graph: "syncing",
  finalizing: "finalizing",
}

/** Insertion index in BASE_STEP_KEYS where SCIP language steps are spliced. */
const SCIP_INSERT_AFTER = BASE_STEP_KEYS.indexOf("detecting_languages")

/**
 * Returns the badge word for a given step key.
 * All `scip:<lang>` keys map to "indexing" (no language name in the UI).
 */
export function getBadgeWord(key: IndexingStepKey): BadgeWord {
  if (key.startsWith("scip:")) return "indexing"
  return BADGE_BY_BASE_KEY[key as BaseStepKey] ?? "indexing"
}

/**
 * Builds an ordered list of step keys for a run, inserting `scip:<lang>` keys
 * after `detecting_languages`.
 */
export function buildIndexingChecklist(
  scipLanguages: string[] = [],
): IndexingStepKey[] {
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
 * Returns `null` when the key is not found in the checklist.
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
