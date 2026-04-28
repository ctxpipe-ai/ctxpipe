import { getOrgDb } from "../../../db/client.js"
import { getLogger } from "../../../observability/logger.js"
import { retractIngestionForDiffPg } from "../../../retrieval/services/ingestionRetraction.js"
import type { CodeIngestionState } from "../schemas.js"

export async function retractStaleEvidence(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
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
