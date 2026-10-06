import { linkPackageHierarchy } from "../../graphs/codeIngestionGraph/nodes/linkLocatedPaths.js"
import { finalizeExtractedReferences } from "../../graphs/codeIngestionGraph/runExtractRoot.js"
import {
  deleteExtractionCapture,
  type ExtractionCaptureKey,
  InvalidExtractionCaptureError,
  loadExtractionCapture,
} from "../../models/repository-extraction-captures.js"
import {
  type CapturedExtraction,
  capturedExtractionSchema,
  captureExtractionClaimSourcePath,
  type WorkspaceExtraction,
} from "./extraction.js"
import { planCapturedExtraction } from "./plan-extraction.js"

function captureKey(
  orgId: string,
  extraction: WorkspaceExtraction,
): ExtractionCaptureKey {
  return {
    orgId,
    repositoryId: extraction.repositoryId,
    sourceSha: extraction.sourceSha,
    scope: extraction.capture.scope,
    extractorVersion: extraction.capture.extractorVersion,
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
    captureKey(orgId, extraction),
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
  const parsed = capturedExtractionSchema.safeParse({
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
  if (!parsed.success)
    throw new InvalidExtractionCaptureError(
      `Extraction capture is invalid: ${parsed.error.issues[0]?.message}`,
    )
  return parsed.data
}

/**
 * Load and plan the stored capture of a queued extraction. When the capture
 * does not parse or does not plan, delete its rows and fail: a retry with the
 * same rows fails again, and the next ingestion run must extract it again.
 * A database error is not a capture error and keeps the rows.
 */
export async function planStoredExtraction(
  input: Omit<Parameters<typeof planCapturedExtraction>[0], "extraction"> & {
    orgId: string
    extraction: WorkspaceExtraction
  },
): Promise<Awaited<ReturnType<typeof planCapturedExtraction>>> {
  const { orgId, extraction, ...planInput } = input
  const discard = async (error: unknown): Promise<never> => {
    await deleteExtractionCapture(captureKey(orgId, extraction))
    throw error
  }
  const captured = await loadCapturedExtraction(orgId, extraction).catch(
    (error: unknown) => {
      if (error instanceof InvalidExtractionCaptureError) return discard(error)
      throw error
    },
  )
  return planCapturedExtraction({ ...planInput, extraction: captured }).catch(
    discard,
  )
}
