/**
 * identifyInfrastructure – Extracts Infrastructure objects and RUNS_ON claims
 * (Service → Infrastructure) by scanning Dockerfiles, compose files, k8s manifests,
 * and platform config files.
 */

import { requireCurrentOrgId } from "../../../auth/context.js"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type { CodeIngestionState } from "../schemas.js"
import {
  collectDeterministicScanPaths,
  scanInfrastructure,
} from "./deterministicRepoScan.js"
import { processCapturedInfrastructure } from "./identifyInfrastructurePostProcess.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

export async function identifyInfrastructure(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const allPaths = await listFilesRecursive(repositoryId, orgId)
  const scopedPaths =
    scanPaths.length > 0
      ? filterPathsByPartialScan(allPaths, scanPaths)
      : allPaths

  const pathsToFetch = collectDeterministicScanPaths(allPaths, scanPaths)
  const contents = await fetchFiles(repositoryId, orgId, pathsToFetch)

  let submissions = scanInfrastructure(scopedPaths, contents).map((inf) => ({
    infraType: inf.infraType,
    path: inf.path,
    evidence: inf.evidence,
  }))

  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((inf) =>
      repoPathMatchesPartialScan(inf.path, scanPaths),
    )
  }

  const result = processCapturedInfrastructure(
    submissions,
    repositoryId,
    roots,
    targetHash,
    "deterministic",
  )
  return {
    extractedObjects: result.extractedObjects,
    extractedClaims: result.extractedClaims,
  }
}
