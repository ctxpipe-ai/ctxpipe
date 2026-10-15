import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/** One GitHub repository as `owner/name`. */
const repositoryNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "Use owner/name, for example acme/web",
  )

/** A branch or tag name that git accepts in a fetch. */
const refSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?![-/])(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\\p{Cc}]+(?<![./])$/u,
    "Use a branch or tag name",
  )

/**
 * One linked repository: `owner/name`, or a map with an optional `ref`
 * (branch or tag). Without `ref`, ctx| reads the default branch.
 */
const repositoryItemSchema = z.union([
  repositoryNameSchema,
  z.strictObject({ name: repositoryNameSchema, ref: refSchema.optional() }),
])

function itemName(item: z.infer<typeof repositoryItemSchema>): string {
  return typeof item === "string" ? item : item.name
}

export const githubScopeSchema = z.strictObject({
  repositories: z
    .array(repositoryItemSchema)
    .min(1, "Select at least one repository")
    .refine(
      (items) =>
        new Set(items.map((item) => itemName(item).toLowerCase())).size ===
        items.length,
      "Each repository can occur only one time",
    ),
})

/** The repositories of a valid GitHub scope, each with its ref or null. */
export function githubScopeRepositories(
  scope: GithubSourceScope,
): Array<{ name: string; ref: string | null }> {
  return scope.repositories.map((item) =>
    typeof item === "string"
      ? { name: item, ref: null }
      : { name: item.name, ref: item.ref ?? null },
  )
}

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
