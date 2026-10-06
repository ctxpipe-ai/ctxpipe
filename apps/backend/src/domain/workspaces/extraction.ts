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

// The command carries each path of a partial retraction; this keeps the
// workflow input and the write-job payload bounded.
const MAX_PARTIAL_RETRACTION_PATHS = 100_000

/**
 * The paths a partial ingest retracts, or null when there are too many for
 * the command. The workflow calls this before the model calls. On null it
 * extracts and retracts the full repository: a change set this large is near
 * a full rewrite, and a rejection would block the repository on each run.
 */
export function partialRetractionPaths(changes: {
  changedPaths?: string[]
  deletedPaths?: string[]
  renames?: Array<{ from: string; to: string }>
}): string[] | null {
  const paths = [
    ...new Set([
      ...(changes.changedPaths ?? []),
      ...(changes.deletedPaths ?? []),
      ...(changes.renames ?? []).flatMap((rename) => [rename.from, rename.to]),
    ]),
  ]
  return paths.length > MAX_PARTIAL_RETRACTION_PATHS ? null : paths
}

/** Source identity of a queued extraction. Write jobs check it before a push. */
const extractionHeaderShape = {
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
          paths: z
            .array(repositoryFilePathSchema)
            .max(MAX_PARTIAL_RETRACTION_PATHS),
        })
        .strict(),
    ])
    .optional(),
  sourceSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
}

/**
 * Queued extraction command. The extractor output stays in
 * `repository_extraction_captures`; the command carries only its key, so the
 * workflow input and the write-job payload stay small for any repository size.
 */
export const workspaceExtractionSchema = z
  .object({
    ...extractionHeaderShape,
    capture: z
      .object({
        scope: z.string().min(1),
        extractorVersion: z.number().int().positive(),
        roots: extractionRootsSchema,
      })
      .strict(),
  })
  .strict()

export type WorkspaceExtraction = z.infer<typeof workspaceExtractionSchema>

/**
 * The retraction of a queued extraction. When the extractors skipped files
 * after a model error, the capture does not hold the facts of those files, and
 * a retraction would expire them. Then the command retracts nothing.
 */
export function extractionRetraction(input: {
  partialPaths: string[] | null
  observedAt: string
  skippedFiles: number
}): WorkspaceExtraction["retraction"] {
  if (input.skippedFiles) return undefined
  return input.partialPaths
    ? {
        mode: "partial",
        observedAt: input.observedAt,
        paths: input.partialPaths,
      }
    : { mode: "full", observedAt: input.observedAt }
}

/** Immutable extractor output. Projection tables are never an extraction source. */
const capturedExtractionShapeSchema = z
  .object({
    ...extractionHeaderShape,
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

export type CapturedExtraction = z.infer<typeof capturedExtractionShapeSchema>

/** Merge partial observations in encounter order before the command is persisted. */
export const capturedExtractionSchema = capturedExtractionShapeSchema.transform(
  (batch): CapturedExtraction => {
    const objects = new Map<string, CapturedExtraction["objects"][number]>()
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
  },
)

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
