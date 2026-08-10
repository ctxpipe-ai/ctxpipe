/**
 * Codesearch-local copy of the canonical indexing step catalog.
 * Keys and badge words must stay in sync with apps/backend/src/domain/indexingSteps.ts.
 *
 * Only codesearch-phase step keys are written here; the full list is kept so
 * that resolveIndexingStep produces accurate totals relative to the backend catalog.
 */
import { and, eq, isNull, lte, or } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { repositories } from "../db/schema.js"

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

export type IndexingStepKey = BaseStepKey | `scip:${string}`

export type BadgeWord =
  | "queued"
  | "resolving"
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
  index_queue: "indexing",
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

const SCIP_INSERT_AFTER = BASE_STEP_KEYS.indexOf("detecting_languages")

export function getBadgeWord(key: IndexingStepKey): BadgeWord {
  if (key.startsWith("scip:")) return "indexing"
  return BADGE_BY_BASE_KEY[key as BaseStepKey] ?? "indexing"
}

export function buildIndexingChecklist(
  scipLanguages: string[] = [],
): IndexingStepKey[] {
  const scipKeys: IndexingStepKey[] = scipLanguages.map(
    (l) => `scip:${l}` as IndexingStepKey,
  )
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
  step: number
  total: number
  key: IndexingStepKey
  badgeWord: BadgeWord
}

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

export function resolveHighestCompletedScipStep(
  completedScipLanguages: ReadonlySet<string>,
  scipLanguages: string[] = [],
): IndexingStepResolution | null {
  let highest: IndexingStepResolution | null = null
  for (const language of scipLanguages) {
    if (!completedScipLanguages.has(language)) continue
    const resolution = resolveIndexingStep(`scip:${language}`, scipLanguages)
    if (resolution && (!highest || resolution.step > highest.step)) {
      highest = resolution
    }
  }
  return highest
}

export type SetRepositoryIndexingStepOptions = {
  /**
   * Only advance the step counter — skip the update when DB step > new step.
   * Used so parallel SCIP/extract writers and retries cannot snap the badge
   * backwards after a later phase already completed.
   */
  monotonic?: boolean
}

/**
 * Write indexing step progress to the repositories row.
 * Errors are surfaced to the caller; use trySetRepositoryIndexingStep for
 * best-effort writes that must not break the indexing pipeline.
 */
export async function setRepositoryIndexingStep(
  db: Db,
  repositoryId: string,
  key: IndexingStepKey,
  scipLanguages: string[] = [],
  options: SetRepositoryIndexingStepOptions = {},
): Promise<void> {
  const resolution = resolveIndexingStep(key, scipLanguages)
  if (!resolution) return
  const idCondition = eq(repositories.id, repositoryId)
  const where = options.monotonic
    ? and(
        idCondition,
        or(
          isNull(repositories.indexingStep),
          lte(repositories.indexingStep, resolution.step),
        ),
      )
    : idCondition
  await db
    .update(repositories)
    .set({
      indexingStep: resolution.step,
      indexingStepTotal: resolution.total,
      indexingStepKey: resolution.key,
    })
    .where(where)
}

/**
 * Best-effort variant — swallows all errors so step writes never abort indexing.
 */
export async function trySetRepositoryIndexingStep(
  db: Db,
  repositoryId: string,
  key: IndexingStepKey,
  scipLanguages: string[] = [],
  options: SetRepositoryIndexingStepOptions = {},
): Promise<void> {
  try {
    await setRepositoryIndexingStep(
      db,
      repositoryId,
      key,
      scipLanguages,
      options,
    )
  } catch {
    // step writes are best-effort; indexing must continue
  }
}
