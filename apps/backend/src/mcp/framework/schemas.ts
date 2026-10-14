import { z } from "zod"

/** The Workspace slug argument of a tool. */
export const workspaceArgument = z
  .string()
  .min(1)
  .max(64)
  .describe("Workspace slug from list_workspaces.")

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
