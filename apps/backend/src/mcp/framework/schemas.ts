import { z } from "zod"

/** The Workspace slug argument of a tool. */
export const workspaceArgument = z
  .string()
  .min(1)
  .max(64)
  .describe("Workspace slug from list_workspaces.")

/**
 * The branch argument of a knowledge read (ADR-071 decision 6). Absent: the
 * default branch of the Workspace.
 */
export const branchArgument = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .optional()
  .describe(
    "A branch of the Workspace repository. Default: the default branch. A branch can be read after a commit on it is projected.",
  )

/** `excludeRepositories`: the repositories the agent has open locally. */
export const excludeRepositoriesSchema = z
  .array(z.string().min(1).max(512))
  .max(20)
  .describe(
    "Repositories the agent has open locally (handles or git URLs). Pass the output of `git remote get-url origin`. A ref into one of them gives excluded_repository.",
  )

/** The branch and SHA of the content that a result serves (ADR-051 §5). */
export const servedSchema = z.object({
  branch: z.string(),
  sha: z.string(),
})

/**
 * The times of a knowledge unit in each tool output that names one
 * (CTX-1710), as ISO 8601 strings.
 */
export const documentTimesShape = {
  createdAt: z
    .string()
    .nullable()
    .describe("When the item began in its source (ISO 8601). Null: unknown."),
  updatedAt: z
    .string()
    .nullable()
    .describe(
      "When the content last changed in its source (ISO 8601). Compare it to find the newest source. Null: unknown.",
    ),
  expiresAt: z
    .string()
    .optional()
    .describe(
      "The author's hint that the content is stale after this time (ISO 8601). Only when the author set it. An expired unit can still be correct.",
    ),
}

/** The times of a unit as the tools give them: `expiresAt` only when set. */
export function documentTimesOutput(times: {
  createdAt: Date | null
  updatedAt: Date | null
  expiresAt: Date | null
}) {
  return {
    createdAt: times.createdAt?.toISOString() ?? null,
    updatedAt: times.updatedAt?.toISOString() ?? null,
    ...(times.expiresAt ? { expiresAt: times.expiresAt.toISOString() } : {}),
  }
}

/**
 * A Workspace or repository that the call did not use, with the reason. A
 * repository without an index is `not_indexed`; a Workspace without a
 * published revision is `not_ready`; a stored repository URL that does not
 * parse is `invalid_url`.
 */
export const skippedSchema = z.object({
  repository: z.string().optional(),
  workspace: z.string().optional(),
  reason: z.enum([
    "not_indexed",
    "failed",
    "over_limit",
    "not_ready",
    "invalid_url",
  ]),
})
export type Skipped = z.infer<typeof skippedSchema>
