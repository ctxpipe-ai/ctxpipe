import type { Db } from "../../db/client.js"
import { log } from "../../observability/logger.js"
import { trySetRepositoryIndexingStep } from "../indexingSteps.js"
import { zoektRepositoryName } from "../zoekt/shardPrefix.js"
import {
  withIndexConcurrency,
  withRepositoryIndexOperation,
} from "./indexConcurrency.js"
import { isMemoryFitFailure } from "./memoryFitError.js"
import {
  discardScipShardFiles,
  type IndexPhaseRepoContext,
  phaseCloneCheckout,
  phaseDetectLanguages,
  phaseMarkCheckoutIndexed,
  phaseMergeScip,
  phaseScipLanguage,
  phaseZoekt,
  publishMergedScipIndex,
  writeMergedScipIndex,
} from "./phases.js"

export type IndexRepoResult = {
  targetHash: string
  ingestMode: "full" | "partial"
  changedPaths: string[]
  deletedPaths: string[]
  renames: { from: string; to: string }[]
}

type IndexInput = {
  db: Db
  orgId: string
  repoId: string
  repoGitUrl: string
  clonePath: string
  scipIndexPath: string
  githubToken?: string
  zoektRepoId: number
  repoName: string
  repoUrl: string
  /** Commit SHA or ref to checkout before indexing. If omitted, default branch is resolved via remote. */
  targetHash?: string
  /** Optional previous indexed commit for partial ingestion metadata (diff + ancestor check). */
  fromHash?: string
}

export { discardScipShardFiles, publishMergedScipIndex, writeMergedScipIndex }

export type OptionalIndexPhaseResult =
  | { ok: true }
  | { ok: false; error: unknown }

/**
 * Run an optional index phase. Failures are warnings so non-OW callers get
 * the same degradation as OpenWorkflow. Clone/detect stay fail-closed at
 * their call sites. Callers inspect the result when a failure changes
 * later steps (Zoekt memory-fit skips SCIP langs).
 */
export async function runOptionalIndexPhase(
  step: string,
  fn: () => Promise<void>,
  extra?: Record<string, string>,
): Promise<OptionalIndexPhaseResult> {
  try {
    await fn()
    return { ok: true }
  } catch (reason) {
    log.warn({
      step,
      ...extra,
      error: reason instanceof Error ? reason.message : String(reason),
    })
    return { ok: false, error: reason }
  }
}

function toPhaseContext(input: IndexInput): IndexPhaseRepoContext {
  return {
    db: input.db,
    orgId: input.orgId,
    repoId: input.repoId,
    repoGitUrl: input.repoGitUrl,
    clonePath: input.clonePath,
    scipIndexPath: input.scipIndexPath,
    zoektRepoId: input.zoektRepoId,
    zoektName: zoektRepositoryName({
      orgId: input.orgId,
      repoId: input.repoId,
    }),
    repoName: input.repoName,
    repoUrl: input.repoUrl,
    githubToken: input.githubToken,
  }
}

/**
 * Legacy monolithic `POST /:repoId/index` composer.
 * Zoekt and SCIP indexer failures degrade; clone/detect stay fail-closed.
 * Zoekt memory-fit skips SCIP langs and merges `[]`, matching OpenWorkflow.
 * Durable ingestion uses OpenWorkflow phase endpoints instead.
 */
export async function cloneAndIndexRepository(
  input: IndexInput,
): Promise<IndexRepoResult> {
  return withRepositoryIndexOperation(input.repoId, () =>
    withIndexConcurrency(
      () => cloneAndIndexRepositoryInner(input),
      () => trySetRepositoryIndexingStep(input.db, input.repoId, "index_queue"),
    ),
  )
}

async function cloneAndIndexRepositoryInner(
  input: IndexInput,
): Promise<IndexRepoResult> {
  const ctx = toPhaseContext(input)
  const checkout = await phaseCloneCheckout(ctx, {
    targetHash: input.targetHash,
    fromHash: input.fromHash,
  })

  const zoekt = await runOptionalIndexPhase(
    "codesearch.index.zoekt.failed",
    () => phaseZoekt(ctx),
  )
  const skipScipAfterZoektMemory = !zoekt.ok && isMemoryFitFailure(zoekt.error)

  const detectResult = await phaseDetectLanguages(ctx, {
    ingestMode: checkout.ingestMode,
    changedPaths: checkout.changedPaths,
    deletedPaths: checkout.deletedPaths,
    renames: checkout.renames,
  })
  const detectedLanguages = detectResult.detectedLanguages
  const languagesToIndex = skipScipAfterZoektMemory
    ? []
    : detectResult.languagesToIndex
  if (skipScipAfterZoektMemory) {
    log.warn({
      step: "codesearch.index.scip.skipped",
      reason: "zoekt_memory_fit",
    })
  }
  await Promise.all(
    languagesToIndex.map((language) =>
      runOptionalIndexPhase(
        "codesearch.index.scip.lang.failed",
        () =>
          phaseScipLanguage(ctx, {
            language,
            detectedLanguages,
          }),
        { language },
      ),
    ),
  )
  await runOptionalIndexPhase(
    "codesearch.index.scip.merge.failed",
    async () => {
      await phaseMergeScip(ctx, {
        detectedLanguages,
        ...(skipScipAfterZoektMemory ? { languagesToMerge: [] } : {}),
      })
    },
  )

  await phaseMarkCheckoutIndexed(ctx)

  return {
    targetHash: checkout.targetHash,
    ingestMode: checkout.ingestMode,
    changedPaths: checkout.changedPaths,
    deletedPaths: checkout.deletedPaths,
    renames: checkout.renames,
  }
}
