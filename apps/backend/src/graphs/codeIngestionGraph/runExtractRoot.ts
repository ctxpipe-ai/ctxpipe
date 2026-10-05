import { isUnresolvedProviderIdentity } from "../../domain/codeIngestion/referenceResolver.js"
import {
  type CapturedExtraction,
  capturedExtractionSchema,
  captureExtractionClaimSourcePath,
  type WorkspaceExtraction,
} from "../../domain/workspaces/extraction.js"
import {
  type ExtractionCaptureKey,
  loadExtractionCapture,
  storedRootCapture,
  storeRootCapture,
} from "../../models/repository-extraction-captures.js"
import { CONNECTOR_EXTRACTORS } from "./nodes/connectorExtractors.js"
import { extractCodeowners } from "./nodes/extractCodeowners.js"
import { extractDecisions } from "./nodes/extractDecisions.js"
import { extractInstructionUnits } from "./nodes/extractInstructionUnits.js"
import { extractKind } from "./nodes/extractKind.js"
import { identifyAPIClients } from "./nodes/identifyAPIClients.js"
import { identifyAPIs } from "./nodes/identifyAPIs.js"
import { identifyDatabases } from "./nodes/identifyDatabases.js"
import { identifyInfrastructure } from "./nodes/identifyInfrastructure.js"
import { identifyLibraries } from "./nodes/identifyLibraries.js"
import { identifyPatterns } from "./nodes/identifyPatterns.js"
import { identifyServiceDependencies } from "./nodes/identifyServiceDependencies.js"
import { identifyStreams } from "./nodes/identifyStreams.js"
import {
  linkLocatedPaths,
  linkPackageHierarchy,
  resolveReferenceClaims,
} from "./nodes/linkLocatedPaths.js"
import { sanitizePostgresJson } from "./postgresJson.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "./schemas.js"

/**
 * Version of the extractor output in `repository_extraction_captures`. Increase
 * it when an extractor changes its output, so that a new run does not reuse
 * root captures of an older extractor.
 */
export const EXTRACTOR_VERSION = 1

/** Stable OpenWorkflow step-name fragment for a package root path. */
export function stableRootStepId(root: string): string {
  const trimmed = root.trim()
  if (trimmed === "" || trimmed === "./" || trimmed === ".") return "repo-root"
  return trimmed
    .replace(/^\.\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120)
}

function concatExtracted(parts: Array<Partial<CodeIngestionState>>): {
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
} {
  const extractedObjects: ExtractedObject[] = []
  const extractedClaims: ExtractedClaim[] = []
  for (const part of parts) {
    if (part.extractedObjects?.length) {
      extractedObjects.push(...part.extractedObjects)
    }
    if (part.extractedClaims?.length) {
      extractedClaims.push(...part.extractedClaims)
    }
  }
  return { extractedObjects, extractedClaims }
}

/**
 * Per-root extract sequence: extractKind, then parallel identify_* +
 * extractInstructionUnits + decisions + CODEOWNERS + the connector extractor
 * registry, then path locating.
 *
 * Used by OpenWorkflow `repository-ingestion` so each phase is a durable step
 * boundary when callers wrap these in `step.run`. A root that an earlier run
 * already stored under the same key returns null and makes no model calls.
 */
export async function runExtractKindForRoot(
  state: CodeIngestionState,
  root: string,
  captureKey: ExtractionCaptureKey,
): Promise<Partial<CodeIngestionState> | null> {
  if (await storedRootCapture(captureKey, root)) return null
  return extractKind({ ...state, roots: [root] })
}

/**
 * Run the identify phase of one root and store the root capture (kind output,
 * identify output, located paths). The step output is only the counts. A
 * stored root is reused without model calls.
 */
export async function runIdentifyPhaseForRoot(
  state: CodeIngestionState,
  root: string,
  kindOutput: Partial<CodeIngestionState> | null,
  captureKey: ExtractionCaptureKey,
): Promise<{ objects: number; claims: number }> {
  const stored = await storedRootCapture(captureKey, root)
  if (stored) return stored
  // The kind step found a stored root that is gone now (a concurrent publish deleted it).
  const kindPartial =
    kindOutput ?? (await extractKind({ ...state, roots: [root] }))
  const rootState: CodeIngestionState = {
    ...state,
    ...kindPartial,
    roots: [root],
    extractedObjects: kindPartial.extractedObjects ?? [],
    extractedClaims: kindPartial.extractedClaims ?? [],
  }

  const parts = await Promise.all([
    identifyAPIClients(rootState),
    identifyAPIs(rootState),
    identifyDatabases(rootState),
    identifyInfrastructure(rootState),
    identifyStreams(rootState),
    identifyServiceDependencies(rootState),
    identifyLibraries(rootState),
    identifyPatterns(rootState),
    extractInstructionUnits(rootState),
    extractDecisions(rootState),
    extractCodeowners(rootState),
    ...CONNECTOR_EXTRACTORS.map((extractor) => extractor.extract(rootState)),
  ])

  const extracted = concatExtracted([kindPartial, ...parts])
  const located = linkLocatedPaths({
    repositoryId: state.repositoryId,
    targetHash: state.targetHash,
    objects: extracted.extractedObjects,
    claims: extracted.extractedClaims,
  })
  extracted.extractedObjects.push(...located.extractedObjects)
  extracted.extractedClaims.push(...located.extractedClaims)
  return storeRootCapture(captureKey, root, sanitizePostgresJson(extracted))
}

/**
 * Once all roots are concatenated, drop reference-family claims whose ends do
 * not resolve to an object of this run or of the existing graph (ADR-033).
 * Runs after the per-root phase because sibling roots' objects are not stored
 * yet on a first ingest.
 */
export async function finalizeExtractedReferences(input: {
  orgId: string
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
}): Promise<{
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
}> {
  const extractedObjects = input.extractedObjects.filter(
    (object) => !isUnresolvedProviderIdentity(object.deduplicationKey),
  )
  const extractedClaims = input.extractedClaims.filter(
    (claim) =>
      !isUnresolvedProviderIdentity(claim.subjectRef) &&
      !isUnresolvedProviderIdentity(claim.objectRef),
  )
  const { claims, stubs } = await resolveReferenceClaims({
    orgId: input.orgId,
    objects: extractedObjects,
    claims: extractedClaims,
  })
  return {
    extractedObjects: [...extractedObjects, ...stubs],
    extractedClaims: claims,
  }
}

/**
 * Read the stored roots of a queued extraction and build the publishable
 * capture: reference resolution and package hierarchy need all roots.
 */
export async function loadCapturedExtraction(
  orgId: string,
  extraction: WorkspaceExtraction,
): Promise<CapturedExtraction> {
  const { capture, ...header } = extraction
  const stored = await loadExtractionCapture(
    {
      orgId,
      repositoryId: header.repositoryId,
      sourceSha: header.sourceSha,
      scope: capture.scope,
      extractorVersion: capture.extractorVersion,
    },
    capture.roots,
  )
  const finalized = await finalizeExtractedReferences({ orgId, ...stored })
  const claims = [
    ...finalized.extractedClaims,
    ...linkPackageHierarchy({
      repositoryId: header.repositoryId,
      targetHash: header.sourceSha,
      objects: finalized.extractedObjects,
      claims: finalized.extractedClaims,
    }),
  ]
  return capturedExtractionSchema.parse({
    ...header,
    objects: finalized.extractedObjects,
    claims: claims.map((claim) => ({
      subjectRef: claim.subjectRef,
      objectRef: claim.objectRef,
      predicate: claim.predicate,
      confidence: claim.confidence,
      sourceId: claim.sourceId,
      sourcePath: captureExtractionClaimSourcePath(claim.provenance),
    })),
  })
}
