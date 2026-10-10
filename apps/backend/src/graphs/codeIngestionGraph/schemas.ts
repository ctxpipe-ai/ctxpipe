import { z } from "zod/v3"
import { ExtractionMethod, SourceType } from "../../retrieval/schema/claims.js"
import { CoreNodeType } from "../../retrieval/schema/core.js"
import { ExtensionNodeType } from "../../retrieval/schema/extension.js"

/** Known ID prefixes - refs with these are IDs, else deduplicationKeys */
const ID_PREFIXES = [
  "repo_",
  "obj_",
  "svc_",
  "app_",
  "api_",
  "str_",
  "db_",
  "inf_",
  "lib_",
  "pat_",
  "dec_",
  "inu_",
  "skl_",
  "prq_",
  "fil_",
]

export function isIdRef(ref: string): boolean {
  return ID_PREFIXES.some((p) => ref.startsWith(p))
}

/** Extracted object before deduplication - has deduplicationKey, no id yet */
export const ExtractedObjectSchema = z.object({
  kind: CoreNodeType.or(ExtensionNodeType),
  deduplicationKey: z.string().min(1),
  name: z.string().optional(),
  summary: z.string().max(500).optional(),
  payload: z.record(z.unknown()).optional(),
})

/** Extracted claim - subjectRef/objectRef are ID or deduplicationKey; kinds set at creation */
export const ExtractedClaimSchema = z.object({
  subjectRef: z.string().min(1),
  subjectKind: z.string().min(1),
  objectRef: z.string().min(1),
  objectKind: z.string().min(1),
  predicate: z.string().min(1),
  sourceId: z.string().min(1),
  sourceType: SourceType,
  extractionMethod: ExtractionMethod,
  confidence: z.number().min(0).max(1),
  provenance: z.record(z.unknown()).optional(),
  /** Claim validity window as ISO dates (YYYY-MM-DD); change edges set validFrom to the merge date. */
  validFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  validTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})

export type ExtractedObject = z.infer<typeof ExtractedObjectSchema>
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>

/** Extractor output of one or more package roots. */
export type ExtractedCapture = {
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
}

const CodeIngestionRenameSchema = z.object({
  from: z.string(),
  to: z.string(),
})

/** Full code ingestion state */
export const CodeIngestionStateSchema = z.object({
  requestId: z.string().min(1).optional(),
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  /** Required when repo is linked to a GitHub connection (multi-app / per-connection credentials). */
  githubConnectionId: z.string().min(1).optional(),
  fromHash: z.string().optional(),
  targetHash: z.string().min(1),
  ingestMode: z.enum(["full", "partial"]).optional(),
  changedPaths: z.array(z.string()).optional(),
  deletedPaths: z.array(z.string()).optional(),
  renames: z.array(CodeIngestionRenameSchema).optional(),
  indexedAt: z.string().optional(),
  /**
   * Candidate files an extractor skipped because its LLM call failed. A full
   * ingest only sweeps unobserved evidence when this is 0 (ADR-033 §11).
   */
  extractionSkippedFiles: z.number().int().nonnegative().optional(),
  roots: z.array(z.string()).optional(),
  /**
   * False when a run extracts one root at a time and another root reads the
   * repo-root instruction files (`repoRootInstructionOwner`).
   */
  ownsRepoRootInstructions: z.boolean().optional(),
  extractedObjects: z.array(ExtractedObjectSchema).default([]),
  extractedClaims: z.array(ExtractedClaimSchema).default([]),
})

export type CodeIngestionState = z.infer<typeof CodeIngestionStateSchema>
