import { z } from "zod/v3"
import { ExtractionMethod, SourceType } from "../../retrieval/schema/claims.js"
import { CoreNodeType } from "../../retrieval/schema/core.js"
import { ExtensionNodeType } from "../../retrieval/schema/extension.js"

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
})

export type ExtractedObject = z.infer<typeof ExtractedObjectSchema>
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>

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
  roots: z.array(z.string()).optional(),
  extractedObjects: z.array(ExtractedObjectSchema).default([]),
  extractedClaims: z.array(ExtractedClaimSchema).default([]),
})

export type CodeIngestionState = z.infer<typeof CodeIngestionStateSchema>
