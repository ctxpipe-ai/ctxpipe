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
  resolveReferenceClaims,
} from "./nodes/linkLocatedPaths.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "./schemas.js"

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
 * Per-root extract DAG (same shape as extractionSubgraph):
 * extractKind, then parallel identify_* + extractInstructionUnits + decisions +
 * CODEOWNERS + the connector extractor registry, then path locating.
 *
 * Used by OpenWorkflow `repository-ingestion` so each phase is a durable step
 * boundary when callers wrap these in `step.run`.
 */
export async function runExtractKindForRoot(
  state: CodeIngestionState,
  root: string,
): Promise<Partial<CodeIngestionState>> {
  return extractKind({ ...state, roots: [root] })
}

export async function runIdentifyPhaseForRoot(
  state: CodeIngestionState,
  root: string,
  kindPartial: Partial<CodeIngestionState>,
): Promise<{
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
  /** Files an extractor skipped on LLM failure; gates the full-ingest sweep. */
  extractionSkippedFiles: number
}> {
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
  const extractionSkippedFiles = parts.reduce(
    (sum, part) => sum + (part.extractionSkippedFiles ?? 0),
    0,
  )
  return {
    ...concatExtracted([
      extracted,
      linkLocatedPaths({
        repositoryId: state.repositoryId,
        targetHash: state.targetHash,
        objects: extracted.extractedObjects,
        claims: extracted.extractedClaims,
      }),
    ]),
    extractionSkippedFiles,
  }
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
  const { claims, stubs } = await resolveReferenceClaims({
    orgId: input.orgId,
    objects: input.extractedObjects,
    claims: input.extractedClaims,
  })
  return {
    extractedObjects: [...input.extractedObjects, ...stubs],
    extractedClaims: claims,
  }
}

/**
 * Full per-root extract (kind → parallel identify → reference resolution).
 * Prefer splitting across OW steps via {@link runExtractKindForRoot} +
 * {@link runIdentifyPhaseForRoot} + {@link finalizeExtractedReferences}
 * when durability at the kind boundary is needed.
 */
export async function runExtractForRoot(
  state: CodeIngestionState,
  root: string,
): Promise<{
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
}> {
  const kindPartial = await runExtractKindForRoot(state, root)
  const extracted = await runIdentifyPhaseForRoot(state, root, kindPartial)
  return finalizeExtractedReferences({ orgId: state.orgId, ...extracted })
}
