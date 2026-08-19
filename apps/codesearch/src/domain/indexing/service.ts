import type { Db } from "../../db/client.js"
import { log } from "../../observability/logger.js"
import { trySetRepositoryIndexingStep } from "../indexingSteps.js"
import { zoektRepositoryName } from "../zoekt/shardPrefix.js"
import {
  withIndexConcurrency,
  withRepositoryIndexOperation,
} from "./indexConcurrency.js"
import {
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

export { publishMergedScipIndex, writeMergedScipIndex }

/**
 * Run Zoekt then SCIP sequentially (reduces peak RSS vs parallel phases).
 * Indexer failures are warnings so non-OW callers get the same degradation
 * as OpenWorkflow. Clone/detect stay fail-closed at their call sites.
 */
export async function settleIndexPhases(
  zoektPhase: () => Promise<void>,
  scipPhase: () => Promise<void>,
): Promise<void> {
  try {
    await zoektPhase()
  } catch (reason) {
    log.warn({
      step: "codesearch.index.zoekt.failed",
      error: reason instanceof Error ? reason.message : String(reason),
    })
  }
  try {
    await scipPhase()
  } catch (reason) {
    log.warn({
      step: "codesearch.index.scip.failed",
      error: reason instanceof Error ? reason.message : String(reason),
    })
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

  try {
    await phaseZoekt(ctx)
  } catch (reason) {
    log.warn({
      step: "codesearch.index.zoekt.failed",
      error: reason instanceof Error ? reason.message : String(reason),
    })
  }

  const detectResult = await phaseDetectLanguages(ctx, {
    ingestMode: checkout.ingestMode,
    changedPaths: checkout.changedPaths,
    deletedPaths: checkout.deletedPaths,
    renames: checkout.renames,
  })
  const detectedLanguages = detectResult.detectedLanguages
  await Promise.all(
    detectResult.languagesToIndex.map(async (language) => {
      try {
        await phaseScipLanguage(ctx, {
          language,
          detectedLanguages,
        })
      } catch (reason) {
        log.warn({
          step: "codesearch.index.scip.lang.failed",
          language,
          error: reason instanceof Error ? reason.message : String(reason),
        })
      }
    }),
  )
  try {
    await phaseMergeScip(ctx, {
      detectedLanguages,
    })
  } catch (reason) {
    log.warn({
      step: "codesearch.index.scip.merge.failed",
      error: reason instanceof Error ? reason.message : String(reason),
    })
  }

  await phaseMarkCheckoutIndexed(ctx)

  return {
    targetHash: checkout.targetHash,
    ingestMode: checkout.ingestMode,
    changedPaths: checkout.changedPaths,
    deletedPaths: checkout.deletedPaths,
    renames: checkout.renames,
  }
}
