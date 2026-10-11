import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/** One GitHub repository as `owner/name`. */
const repositoryNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "Use owner/name, for example acme/web",
  )

export const githubScopeSchema = z.strictObject({
  repositories: z
    .array(repositoryNameSchema)
    .min(1, "Select at least one repository")
    .refine(
      (names) =>
        new Set(names.map((name) => name.toLowerCase())).size === names.length,
      "Each repository can occur only one time",
    ),
})

export type GithubSourceScope = z.infer<typeof githubScopeSchema>

/**
 * The GitHub source scope: the repositories linked to the Workspace. ctx|
 * clones and indexes them; it does not mirror them as files.
 */
export const githubSourceScope: SourceScopeDefinition = {
  connectionType: "github",
  label: "GitHub",
  schema: githubScopeSchema,
  summarize: (scope) => {
    const count = githubScopeSchema.parse(scope).repositories.length
    return `${count} linked ${count === 1 ? "repository" : "repositories"}`
  },
}
