/**
 * identifyServiceDependencies extractor
 *
 * Detects cross-service dependencies within a monorepo by scanning package.json
 * workspace references and file: links. Produces DEPENDS_ON claims (Service → Service)
 * only — no new objects. Service nodes are created by extractKind.
 */

import { requireCurrentOrgId } from "../../../auth/context.js"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type { CodeIngestionState, ExtractedClaim } from "../schemas.js"
import {
  buildPackageNameIndex,
  collectDeterministicScanPaths,
  packageJsonPaths,
  scanWorkspaceDependencies,
} from "./deterministicRepoScan.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

export type SubmittedDependency = {
  consumerPath: string
  providerPath: string
  evidence?: string
}

export async function identifyServiceDependencies(
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

  const allPkgPaths = packageJsonPaths(allPaths)
  const scopedPkgPaths = packageJsonPaths(scopedPaths)
  const pathsToFetch = [
    ...new Set([
      ...collectDeterministicScanPaths(allPaths, scanPaths),
      ...allPkgPaths,
    ]),
  ]
  const contents = await fetchFiles(repositoryId, orgId, pathsToFetch)
  const packageIndex = buildPackageNameIndex(allPkgPaths, contents)

  let submissions = scanWorkspaceDependencies(
    scopedPkgPaths,
    contents,
    packageIndex,
  )

  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter(
      (dep) =>
        repoPathMatchesPartialScan(dep.consumerPath, scanPaths) ||
        repoPathMatchesPartialScan(dep.providerPath, scanPaths),
    )
  }

  const claims = postProcessServiceDependencies(submissions, {
    repositoryId,
    roots,
    targetHash,
    extractionMethod: "deterministic",
  })

  return {
    extractedObjects: [],
    extractedClaims: claims,
  }
}

/** Post-process captured dependencies into DEPENDS_ON claims. Exported for testing. */
export function postProcessServiceDependencies(
  capturedDeps: SubmittedDependency[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash"> & {
    extractionMethod?: "deterministic" | "llm"
  },
): ExtractedClaim[] {
  const {
    repositoryId,
    roots = ["./"],
    targetHash,
    extractionMethod = "llm",
  } = state
  const claims: ExtractedClaim[] = []
  const seenPairs = new Set<string>()

  const rootSet = new Set(roots)

  for (const dep of capturedDeps) {
    const consumerRoot = resolveSubmissionRoot(dep.consumerPath, roots)
    const providerRoot = resolveSubmissionRoot(dep.providerPath, roots)

    if (!consumerRoot || !providerRoot) continue
    if (!rootSet.has(consumerRoot) || !rootSet.has(providerRoot)) continue
    if (consumerRoot === providerRoot) continue

    const dedupKey = `${consumerRoot}->${providerRoot}`
    if (seenPairs.has(dedupKey)) continue
    seenPairs.add(dedupKey)

    const subjectRef = `svc:${repositoryId}:${consumerRoot}`
    const objectRef = `svc:${repositoryId}:${providerRoot}`

    claims.push({
      subjectRef,
      subjectKind: "Service",
      objectRef,
      objectKind: "Service",
      predicate: "DEPENDS_ON",
      sourceId: `identifyServiceDependencies:${repositoryId}:${consumerRoot}:${providerRoot}:${targetHash}`,
      sourceType: "git",
      extractionMethod,
      confidence: extractionMethod === "deterministic" ? 0.9 : 0.8,
      provenance: {
        consumerPath: dep.consumerPath,
        providerPath: dep.providerPath,
        evidence: dep.evidence,
      },
    })
  }

  return claims
}
