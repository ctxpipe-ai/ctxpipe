import { z } from "zod"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"

/** Immutable extractor output. Projection tables are never an extraction source. */
export const workspaceExtractionSchema = z
  .object({
    repositoryId: z.string().min(1),
    repositoryUrl: linkedRepositoryUrlSchema,
    sourceSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    objects: z.array(
      z
        .object({
          kind: z.string().min(1),
          deduplicationKey: z.string().min(1),
          name: z.string().optional(),
          summary: z.string().optional(),
          payload: z.record(z.string(), z.json()).optional(),
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          subjectRef: z.string().min(1),
          objectRef: z.string().min(1),
          predicate: z.string().min(1),
          confidence: z.number().min(0).max(1),
          sourceId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()

export type WorkspaceExtraction = z.infer<typeof workspaceExtractionSchema>
