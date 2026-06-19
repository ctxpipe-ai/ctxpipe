/**
 * identifyStreams – Extracts message/event stream usage from manifest dependencies.
 *
 * Detects Kafka, RabbitMQ, SQS, SNS, Redis Pub/Sub, NATS, Pulsar, and similar
 * streaming/messaging systems. Produces Stream objects and PRODUCES_TO /
 * CONSUMES_FROM claims linking Service nodes to Stream nodes.
 */

import { requireCurrentOrgId } from "../../../auth/context.js"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type { CodeIngestionState } from "../schemas.js"
import {
  collectDeterministicScanPaths,
  manifestPaths,
  scanStreams,
} from "./deterministicRepoScan.js"
import { processStreamSubmissions } from "./identifyStreamsProcess.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

export async function identifyStreams(
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
  const scopedManifests = manifestPaths(scopedPaths)

  let submissions = scanStreams(scopedManifests, contents).map((stream) => ({
    streamType: stream.streamType,
    path: stream.path,
    role: stream.role,
    evidence: stream.evidence,
  }))

  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((s) =>
      repoPathMatchesPartialScan(s.path, scanPaths),
    )
  }

  const { objects: processedObjects, claims: processedClaims } =
    processStreamSubmissions(submissions, {
      repositoryId,
      roots,
      targetHash,
      extractionMethod: "deterministic",
    })

  return {
    extractedObjects: processedObjects,
    extractedClaims: processedClaims,
  }
}
