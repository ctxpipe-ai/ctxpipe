import {
  deriveSharedRepoRootSkills,
  repoRootInstructionOwner,
} from "../../graphs/codeIngestionGraph/nodes/extractInstructionUnits.js"
import { linkPackageHierarchy } from "../../graphs/codeIngestionGraph/nodes/linkLocatedPaths.js"
import { finalizeExtractedReferences } from "../../graphs/codeIngestionGraph/runExtractRoot.js"
import {
  captureRowRoot,
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
  const owner = repoRootInstructionOwner(capture.roots)
  const stored = await loadExtractionCapture(
    captureKey(orgId, extraction),
    capture.roots.map((root) => captureRowRoot(root, root === owner)),
  )
  const skills = deriveSharedRepoRootSkills({
    repositoryId: header.repositoryId,
    targetHash: header.sourceSha,
    roots: capture.roots,
    capture: stored,
  })
  stored.extractedObjects.push(...skills.objects)
  stored.extractedClaims.push(...skills.claims)
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
 * Load and plan the stored capture of a queued extraction. When a stored row
 * does not parse, or the loaded capture is not valid, delete the rows of the
 * key and fail: a retry with the same rows fails again, and the next ingestion
 * run must extract it again. Any other error keeps the rows. A plan error can
 * come from a workspace file (for example a malformed `claims:` key) and not
 * from the capture, and a database error is not a capture error.
 */
export async function planStoredExtraction(
  input: Omit<Parameters<typeof planCapturedExtraction>[0], "extraction"> & {
    orgId: string
    extraction: WorkspaceExtraction
  },
): Promise<Awaited<ReturnType<typeof planCapturedExtraction>>> {
  const { orgId, extraction, ...planInput } = input
  const captured = await loadCapturedExtraction(orgId, extraction).catch(
    async (error: unknown) => {
      if (error instanceof InvalidExtractionCaptureError)
        await deleteExtractionCapture(captureKey(orgId, extraction))
      throw error
    },
  )
  return planCapturedExtraction({ ...planInput, extraction: captured })
}
