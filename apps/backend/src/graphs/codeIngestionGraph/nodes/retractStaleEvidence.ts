import { getOrgDb } from "../../../db/client.js"
import { getLogger } from "../../../observability/logger.js"
import { retractIngestionForDiffPg } from "../../../retrieval/services/ingestionRetraction.js"
import type { RetractionGraphEffects, RetractionStats } from "../schemas.js"

type RetractionInput = {
  orgId: string
  repositoryId: string
  targetHash: string
  ingestMode?: "full" | "partial"
  changedPaths?: string[]
  deletedPaths?: string[]
  renames?: Array<{ from: string; to: string }>
}

export type RetractionStepResult = {
  retractionStats: RetractionStats
  retractionGraphEffects: RetractionGraphEffects
}

export async function retractStaleEvidence(
  state: RetractionInput,
): Promise<RetractionStepResult> {
  const logger = getLogger()
  const {
    orgId,
    repositoryId,
    targetHash,
    ingestMode = "full",
    changedPaths = [],
    deletedPaths = [],
    renames = [],
  } = state

  logger.set({
    orgId,
    repositoryId,
    targetHash,
    ingestMode,
    changedPathsCount: changedPaths.length,
    deletedPathsCount: deletedPaths.length,
    renamesCount: renames.length,
  })
  logger.info("retracting stale evidence for partial ingest (if applicable)")

  const db = getOrgDb()
  const { stats: retractionStats, graphEffects: retractionGraphEffects } =
    await retractIngestionForDiffPg(db, {
      orgId,
      repositoryId,
      ingestMode,
      changedPaths,
      deletedPaths,
      renames,
    })

  return { retractionStats, retractionGraphEffects }
}
