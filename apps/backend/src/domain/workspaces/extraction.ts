import { z } from "zod"
import { repositoryFilePathSchema } from "../../services/git/file-change.js"
import { mergeExtractionPayloads } from "./extraction-payload.js"
import { isLinkedRepositoryDeclaration } from "./layout.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import { gitObjectIdSchema } from "./revision.js"

/** Leave native step capacity for retries and publication; reject rather than truncate. */
export const extractionRootsSchema = z
  .array(z.string().min(1).max(4096))
  .max(128, "Extraction root capture exceeds 128 roots")

/** Bound each durable capture and the final merged command before parsing nested payloads. */
export const extractionCaptureBudgetSchema = z
  .object({
    objects: z.array(z.unknown()).max(10_000),
    claims: z.array(z.unknown()).max(50_000),
  })
  .passthrough()
  .superRefine((capture, context) => {
    if (Buffer.byteLength(JSON.stringify(capture)) > 8 * 1024 * 1024)
      context.addIssue({
        code: "custom",
        message: "Extraction capture exceeds 8 MiB",
      })
  })

/** Immutable extractor output. Projection tables are never an extraction source. */
const capturedExtractionSchema = z
  .object({
    repositoryId: z.string().min(1),
    ingestionRequestId: z.string().min(1).optional(),
    repositoryUrl: linkedRepositoryUrlSchema,
    sourceDeclaration: z
      .object({
        path: repositoryFilePathSchema.refine(isLinkedRepositoryDeclaration),
        blobSha: gitObjectIdSchema,
      })
      .strict()
      .optional(),
    retraction: z
      .discriminatedUnion("mode", [
        z
          .object({ mode: z.literal("full"), observedAt: z.iso.datetime() })
          .strict(),
        z
          .object({
            mode: z.literal("partial"),
            observedAt: z.iso.datetime(),
            paths: z.array(repositoryFilePathSchema).max(100_000),
          })
          .strict(),
      ])
      .optional(),
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
          sourcePath: repositoryFilePathSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict()

export type WorkspaceExtraction = z.infer<typeof capturedExtractionSchema>

/** Merge partial observations in encounter order before the command is persisted. */
export const workspaceExtractionSchema = extractionCaptureBudgetSchema
  .pipe(capturedExtractionSchema)
  .transform((batch): WorkspaceExtraction => {
    const objects = new Map<string, WorkspaceExtraction["objects"][number]>()
    for (const object of batch.objects) {
      const payload = {
        ...object.payload,
        ...(object.name === undefined ? {} : { name: object.name }),
        ...(object.summary === undefined ? {} : { summary: object.summary }),
      }
      const previous = objects.get(object.deduplicationKey)
      objects.set(object.deduplicationKey, {
        kind: object.kind,
        deduplicationKey: object.deduplicationKey,
        payload: previous
          ? mergeExtractionPayloads(previous.payload ?? {}, payload)
          : payload,
      })
    }
    return { ...batch, objects: [...objects.values()] }
  })

/** Prefer the concrete evidence path; directory-only provenance remains repository-scoped. */
export function captureExtractionClaimSourcePath(
  provenance: Record<string, unknown> | undefined,
): string | undefined {
  for (const key of ["path", "configPath", "consumerPath"]) {
    const value = provenance?.[key]
    if (typeof value !== "string") continue
    const parsed = repositoryFilePathSchema.safeParse(
      value.replace(/^\.\//, ""),
    )
    if (parsed.success) return parsed.data
  }
  return undefined
}
