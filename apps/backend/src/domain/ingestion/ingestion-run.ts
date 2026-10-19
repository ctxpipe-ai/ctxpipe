import { z } from "zod"
import { plainGitUrlSchema } from "../workspace-sources/providers/git.js"

/**
 * The ingestion v2 parent workflow (ADR-052, T09). Its run id is the
 * `<runId>` of the run's ingest sandboxes and ingest refs.
 */
export const INGESTION_V2_WORKFLOW_NAME = "repository-ingestion-v2"

/** The shard child of an ingestion v2 run (T09). */
export const INGESTION_SHARD_WORKFLOW_NAME = "ingestion-shard"

/**
 * The input of an ingestion v2 run that other code reads from
 * `openworkflow.workflow_runs`. `orgId` is a top-level field: the org sweep
 * reads it to find the unfinished runs of an org.
 */
export type IngestionV2RunInput = {
  orgId: string
  /**
   * A shadow run publishes nothing, and its ingest refs stay 7 days after it
   * finished for the comparison. The ref clean-up reads this field.
   */
  shadow: boolean
}

const sha = z.string().regex(/^[0-9a-f]{40}$/)

/**
 * The source repository of a run: a GitHub repository with the connection
 * that reads it, or a plain git repository that ctx| reads over public
 * HTTPS with no credential (CTX-815). A GitHub source can leave out `kind`:
 * an input from before CTX-815 has none.
 */
const githubIngestSourceSchema = z.object({
  kind: z.literal("github").optional(),
  url: z.string().url(),
  githubConnectionId: z.string().min(1),
})

const gitIngestSourceSchema = z.object({
  kind: z.literal("git"),
  url: plainGitUrlSchema,
})

export const ingestSourceSchema = z.union([
  githubIngestSourceSchema,
  gitIngestSourceSchema,
])

/** {@link ingestSourceSchema} with more keys on each member. */
export function ingestSourceWith<T extends z.ZodRawShape>(shape: T) {
  return z.union([
    githubIngestSourceSchema.extend(shape),
    gitIngestSourceSchema.extend(shape),
  ])
}

export type IngestSource = z.infer<typeof ingestSourceSchema>

/** The full input of the parent workflow; it holds the run contract above. */
export const ingestionV2InputSchema = z.object({
  orgId: z.string().min(1),
  shadow: z.boolean(),
  source: ingestSourceSchema,
  /** The source commit. Both pipelines read the same SHA (T20). */
  sha,
  /** The author time of each step commit, so a replay makes the same SHA. */
  authorTime: z.string().datetime(),
  /**
   * Only these Workspaces can be destinations. A re-ingestion gives its own
   * Workspace, so the other Workspaces of the source get no publish. When
   * it is not set, each Workspace that declares the source is a candidate.
   */
  destinations: z.array(z.string().min(1)).min(1).optional(),
})

export type IngestionV2Input = z.infer<typeof ingestionV2InputSchema>

/** `partial` when a Workspace was refused or has a `partial` step. */
export function ingestionV2Status(
  workspaces: ReadonlyArray<{ partial: number; refused?: string }>,
): "done" | "partial" {
  return workspaces.some((w) => w.partial > 0 || w.refused !== undefined)
    ? "partial"
    : "done"
}
