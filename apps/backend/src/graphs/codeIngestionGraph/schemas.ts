import "@langchain/langgraph/zod"
import { z } from "zod/v3"
import type { ClaimForProjection } from "../../retrieval/schema/claimForProjection.js"
import { ClaimForProjectionSchema } from "../../retrieval/schema/claimForProjection.js"
import { CoreNodeType } from "../../retrieval/schema/core.js"
import { ExtensionNodeType } from "../../retrieval/schema/extension.js"
import { ExtractionMethod, SourceType } from "../../retrieval/schema/claims.js"

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
  "con_",
  "cap_",
  "top_",
  "inc_",
  "dec_",
  "inu_",
  "skl_",
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
})

export type ExtractedObject = z.infer<typeof ExtractedObjectSchema>
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>

export type { ClaimForProjection }
export { ClaimForProjectionSchema }

/**
 * Parallel `Send("extractForRoot", …)` branches (multi-root repos) each return
 * partial state. Without a reducer, Zod + LangGraph uses LastValue for arrays,
 * so only one root's claims/objects survive. Concat merges all branches.
 */
function zodArrayConcat<T extends z.ZodTypeAny>(itemSchema: T) {
  const arrSchema = z.array(itemSchema)
  return arrSchema
    .default([])
    .langgraph.reducer(
      (left, right) => {
        if (right === undefined) return left
        return left.concat(Array.isArray(right) ? right : [right])
      },
      arrSchema,
    )
}

/** Full code ingestion state */
export const CodeIngestionStateSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  fromHash: z.string().optional(),
  targetHash: z.string().min(1),
  indexedAt: z.string().optional(),
  roots: z.array(z.string()).optional(),
  extractedObjects: zodArrayConcat(ExtractedObjectSchema),
  extractedClaims: zodArrayConcat(ExtractedClaimSchema),
  objectIds: zodArrayConcat(z.string()),
  claimsForProjection: zodArrayConcat(ClaimForProjectionSchema),
})

export type CodeIngestionState = z.infer<typeof CodeIngestionStateSchema>
