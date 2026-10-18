import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * A Linear team key or project id. The sync uses it as one path segment, so
 * it may hold only letters, digits, `_`, and `-`.
 */
const linearPathSegment = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, digits, '_', or '-'")

/** The team keys of a scope; an absent list is empty. */
export function linearTeams(scope: { teams?: string[] }): string[] {
  return scope.teams ?? []
}

/** The project ids of a scope; an absent list is empty. */
export function linearProjects(scope: { projects?: string[] }): string[] {
  return scope.projects ?? []
}

function unique(items: readonly string[]): boolean {
  return new Set(items).size === items.length
}

export const linearScopeSchema = z
  .object({
    /**
     * Team keys, for example `ENG`. Each team syncs its issues, projects,
     * cycles, and labels under `linear/teams/<key>/`.
     */
    teams: z
      .array(linearPathSegment)
      .max(50, "Select at most 50 teams for one source")
      .optional(),
    /**
     * Linear project ids. Each project syncs its page and its issues, also
     * from other teams, under `linear/projects/<id>/`.
     */
    projects: z
      .array(linearPathSegment)
      .max(100, "Select at most 100 projects for one source")
      .optional(),
    /**
     * "exclude" leaves out Linear customer requests. The default, "limited",
     * mirrors them as in ADR-022.
     */
    customerRequests: z.enum(["exclude", "limited"]).optional(),
  })
  .refine(
    (scope) => linearTeams(scope).length + linearProjects(scope).length > 0,
    {
      message: "Select at least one team or project",
    },
  )
  .refine(
    (scope) => unique(linearTeams(scope).map((team) => team.toUpperCase())),
    {
      message: "Each team must occur one time",
      path: ["teams"],
    },
  )
  .refine((scope) => unique(linearProjects(scope)), {
    message: "Each project must occur one time",
    path: ["projects"],
  })

export type LinearSourceScope = z.infer<typeof linearScopeSchema>

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function summarizeLinearScope(scope: LinearSourceScope): string {
  const projects = linearProjects(scope).length
  const teamCount = linearTeams(scope).length
  if (!teamCount) return count(projects, "Linear project", "Linear projects")
  const teams = count(teamCount, "Linear team", "Linear teams")
  return projects
    ? `${teams} · ${count(projects, "project", "projects")}`
    : teams
}

/**
 * The Linear source scope: teams, plus optional projects. `connection` is
 * the Linear connection; it is bound to one Linear workspace (the Linear
 * organization), which is not a ctx| Workspace.
 */
export const linearSourceScope: SourceScopeDefinition = {
  connectionType: "linear",
  label: "Linear",
  schema: linearScopeSchema,
  // The frame calls summarize only with a scope that the schema accepted.
  summarize: (scope) => summarizeLinearScope(scope as LinearSourceScope),
}
