import {
  linearProjects,
  linearScopeSchema,
  linearTeams,
} from "backend/domain/workspace-sources/providers/linear"
import type { LinearChecklistItem } from "@/features/connectors/components/linear-setup/LinearScopeChecklist"
import type { LinearScope } from "@/features/connectors/queries/linear-connector"

/** The checklist values of a scope: `team:<key>` and `project:<id>`. */
export function linearSelection(scope: Record<string, unknown>): string[] {
  const parsed = linearScopeSchema.safeParse(scope)
  if (!parsed.success) return []
  return [
    ...linearTeams(parsed.data).map((key) => `team:${key}`),
    ...linearProjects(parsed.data).map((id) => `project:${id}`),
  ]
}

/**
 * The checklist: the teams and projects of the Linear workspace, then each
 * selected value that Linear does not list, so that the user can remove it.
 */
export function linearChecklistItems(
  available: readonly LinearScope[],
  selection: readonly string[],
): LinearChecklistItem[] {
  const items = available.flatMap((item): LinearChecklistItem[] =>
    item.type === "team" && item.teamKey
      ? [
          {
            value: `team:${item.teamKey}`,
            type: "team" as const,
            title: item.title,
            code: item.teamKey,
          },
        ]
      : item.type === "project"
        ? [
            {
              value: `project:${item.externalId}`,
              type: "project" as const,
              title: item.title,
              code: item.teamKey,
            },
          ]
        : [],
  )
  const known = new Set(items.map((item) => item.value.toUpperCase()))
  for (const value of selection) {
    if (known.has(value.toUpperCase())) continue
    const [kind, id = ""] = value.split(/:(.*)/)
    items.push({
      value,
      type: kind === "team" ? "team" : "project",
      title: kind === "team" ? "Unknown team" : "Unknown project",
      code: id,
      detail: "Not found in Linear",
    })
  }
  return items
}

/** Keep the selection in the spelling of the checklist values. */
export function matchLinearSelection(
  items: readonly LinearChecklistItem[],
  selection: readonly string[],
): string[] {
  const byUpper = new Map(
    items.map((item) => [item.value.toUpperCase(), item.value]),
  )
  return selection.map((value) => byUpper.get(value.toUpperCase()) ?? value)
}

/**
 * The scope for a selection, or null when it is not valid. Keys of the
 * scope that the editor does not show stay as they are.
 */
export function linearScopeFromSelection(input: {
  base: Record<string, unknown>
  selection: readonly string[]
  includeCustomerRequests: boolean
}): Record<string, unknown> | null {
  const {
    teams: _teams,
    projects: _projects,
    customerRequests: _c,
    ...rest
  } = input.base
  const teams = input.selection.flatMap((value) =>
    value.startsWith("team:") ? [value.slice("team:".length)] : [],
  )
  const projects = input.selection.flatMap((value) =>
    value.startsWith("project:") ? [value.slice("project:".length)] : [],
  )
  const scope = {
    ...rest,
    ...(teams.length ? { teams } : {}),
    ...(projects.length ? { projects } : {}),
    ...(input.includeCustomerRequests
      ? {}
      : { customerRequests: "exclude" as const }),
  }
  return linearScopeSchema.safeParse(scope).success ? scope : null
}
