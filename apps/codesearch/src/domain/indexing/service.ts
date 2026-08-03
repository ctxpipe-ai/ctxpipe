import type { Db } from "../../db/client.js"
import { withIndexConcurrency } from "./indexConcurrency.js"
import { runWithConcurrency } from "./indexerPool.js"
import {
  phaseCloneCheckout,
  phaseDetectLanguages,
  phaseMarkCheckoutIndexed,
  phaseMergeScip,
  phaseScipLanguage,
  phaseZoekt,
  writeMergedScipIndex,
  type IndexPhaseRepoContext,
} from "./phases.js"
import { trySetRepositoryIndexingStep } from "../indexingSteps.js"

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

export { writeMergedScipIndex }

/**
 * Run Zoekt then SCIP sequentially (reduces peak RSS vs parallel phases).
 * Still attempts SCIP after a Zoekt failure so both errors can be reported.
 * Prefer fail-fast (throw on Zoekt) for OpenWorkflow phased indexing.
 */
export async function settleIndexPhases(
  zoektPhase: () => Promise<void>,
  scipPhase: () => Promise<void>,
): Promise<void> {
  const failures: string[] = []
  try {
    await zoektPhase()
  } catch (reason) {
    failures.push(
      `Zoekt: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  }
  try {
    await scipPhase()
  } catch (reason) {
    failures.push(
      `SCIP: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  }
  if (failures.length > 0) {
    throw new Error(`Repository indexing failed:\n${failures.join("\n")}`)
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
    repoName: input.repoName,
    repoUrl: input.repoUrl,
    githubToken: input.githubToken,
  }
}

/**
 * Legacy monolithic `POST /:repoId/index` composer.
 * Preserves settleIndexPhases (SCIP still attempted after Zoekt failure).
 * Durable ingestion uses OpenWorkflow phase endpoints instead.
 */
export async function cloneAndIndexRepository(
  input: IndexInput,
): Promise<IndexRepoResult> {
  return withIndexConcurrency(
    () => cloneAndIndexRepositoryInner(input),
    () => trySetRepositoryIndexingStep(input.db, input.repoId, "index_queue"),
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

  let detectResult: Awaited<ReturnType<typeof phaseDetectLanguages>> | undefined

  await settleIndexPhases(
    () => phaseZoekt(ctx),
    async () => {
      detectResult = await phaseDetectLanguages(ctx, {
        ingestMode: checkout.ingestMode,
        changedPaths: checkout.changedPaths,
        deletedPaths: checkout.deletedPaths,
        renames: checkout.renames,
      })
      await runWithConcurrency(detectResult.languagesToIndex, (language) =>
        phaseScipLanguage(ctx, {
          language,
          detectedLanguages: detectResult!.detectedLanguages,
        }),
      )
      await phaseMergeScip(ctx, {
        detectedLanguages: detectResult!.detectedLanguages,
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
