import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * A Buildkite pipeline slug, for example `web-app`. The slug is also a path
 * segment, so it holds only lower-case letters, digits, `-`, and `_`.
 */
export const buildkitePipelineSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,99}$/,
    "Use a Buildkite pipeline slug, for example web-app",
  )

export const buildkiteSourceScopeSchema = z
  .object({
    /** The pipelines whose latest builds sync. */
    pipelines: z
      .array(buildkitePipelineSlugSchema)
      .min(1, "Select at least one Buildkite pipeline")
      .refine(
        (slugs) => new Set(slugs).size === slugs.length,
        "List each pipeline one time",
      ),
  })
  .strict()

export type BuildkiteSourceScope = z.infer<typeof buildkiteSourceScopeSchema>

/** The Buildkite source scope: a set of pipeline slugs. */
export const buildkiteSourceScope: SourceScopeDefinition<BuildkiteSourceScope> =
  {
    connectionType: "buildkite",
    label: "Buildkite",
    schema: buildkiteSourceScopeSchema,
    summarize: ({ pipelines }) =>
      `${pipelines.length} Buildkite pipeline${pipelines.length === 1 ? "" : "s"}`,
  }
