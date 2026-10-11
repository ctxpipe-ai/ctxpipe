import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * A Linear id or team key. The sync uses it as one path segment, so it may
 * hold only letters, digits, `_`, and `-`.
 */
const linearPathSegment = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, digits, '_', or '-'")

const linearTeamRef = z.object({
  id: linearPathSegment,
  /** The team key, for example `ENG`. The sync writes under `linear/teams/<key>/`. */
  key: linearPathSegment,
  name: z.string().min(1).optional(),
})

const linearProjectRef = z.object({
  id: linearPathSegment,
  name: z.string().min(1).optional(),
})

function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length
}

export const linearScopeSchema = z
  .object({
    /** Each team syncs its issues, projects, cycles, and labels. */
    teams: z.array(linearTeamRef).default([]),
    /** Each project syncs its page and its issues, also from other teams. */
    projects: z.array(linearProjectRef).default([]),
  })
  .refine((scope) => scope.teams.length + scope.projects.length > 0, {
    message: "Select at least one team or project",
  })
  .refine(
    (scope) =>
      unique(scope.teams, (team) => team.id) &&
      unique(scope.teams, (team) => team.key.toUpperCase()),
    { message: "Each team must occur one time", path: ["teams"] },
  )
  .refine((scope) => unique(scope.projects, (project) => project.id), {
    message: "Each project must occur one time",
    path: ["projects"],
  })

export type LinearSourceScope = z.infer<typeof linearScopeSchema>

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The Linear source scope: teams, plus optional projects. `connection` is
 * the Linear connection; it is bound to one Linear workspace (the Linear
 * organization), which is not a ctx| Workspace.
 */
export const linearSourceScope: SourceScopeDefinition<LinearSourceScope> = {
  connectionType: "linear",
  label: "Linear",
  schema: linearScopeSchema as z.ZodType<LinearSourceScope>,
  summarize: (scope) => {
    const projects = scope.projects.length
    if (!scope.teams.length)
      return count(projects, "Linear project", "Linear projects")
    const teams = count(scope.teams.length, "Linear team", "Linear teams")
    return projects
      ? `${teams} · ${count(projects, "project", "projects")}`
      : teams
  },
}
