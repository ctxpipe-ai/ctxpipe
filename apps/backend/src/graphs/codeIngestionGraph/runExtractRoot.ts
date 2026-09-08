import { extractionCaptureBudgetSchema } from "../../domain/workspaces/extraction.js"
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
  extractionCaptureBudgetSchema.parse({
    objects: extractedObjects,
    claims: extractedClaims,
  })
  return { extractedObjects, extractedClaims }
}

/**
 * Per-root extraction sequence:
 * extractKind, then parallel identify_* + extractInstructionUnits.
 *
 * Used by OpenWorkflow `repository-ingestion` so each phase is a durable step
 * boundary when callers wrap these in `step.run`.
 */
export async function runExtractKindForRoot(
  state: CodeIngestionState,
  root: string,
): Promise<Partial<CodeIngestionState>> {
  const result = await extractKind({ ...state, roots: [root] })
  extractionCaptureBudgetSchema.parse({
    objects: result.extractedObjects ?? [],
    claims: result.extractedClaims ?? [],
  })
  return result
}

export async function runIdentifyPhaseForRoot(
  state: CodeIngestionState,
  root: string,
  kindPartial: Partial<CodeIngestionState>,
): Promise<{
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
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
  ])

  return concatExtracted([kindPartial, ...parts])
}
