import {
  SOURCE_SCOPES,
  type SourceProvider,
} from "backend/domain/workspace-sources/sources-file"

import type { WorkspaceSourceInput } from "./queries"

/** The state of the "Add to Workspaces" wizard step. */
export type ChooseWorkspacesValue = {
  workspaceSlugs: string[]
  /** One scope for all selected Workspaces, or one scope for each. */
  scopeMode: "shared" | "per_workspace"
  /** `null` while the scope editor reports an incomplete scope. */
  sharedScope: Record<string, unknown> | null
  /** Per Workspace slug. A missing key starts from `{}`. */
  scopes: Record<string, Record<string, unknown> | null>
}

export function emptyChooseWorkspaces(): ChooseWorkspacesValue {
  return {
    workspaceSlugs: [],
    scopeMode: "shared",
    sharedScope: {},
    scopes: {},
  }
}

/**
 * The step after the user checks or unchecks a Workspace. One Workspace uses
 * the shared scope, so when one Workspace stays from a scope for each, its own
 * scope becomes the shared scope.
 */
export function selectWorkspaces(
  value: ChooseWorkspacesValue,
  workspaceSlugs: string[],
): ChooseWorkspacesValue {
  const [only] = workspaceSlugs
  return value.scopeMode === "per_workspace" &&
    workspaceSlugs.length === 1 &&
    only !== undefined &&
    only in value.scopes
    ? { ...value, workspaceSlugs, sharedScope: value.scopes[only] ?? null }
    : { ...value, workspaceSlugs }
}

/**
 * The add requests for the step: one for each selected Workspace. `null`
 * until each Workspace has a scope that the provider schema accepts.
 */
export function chooseWorkspacesRequests(
  value: ChooseWorkspacesValue,
  base: { provider: SourceProvider; connectionId: string },
): { workspaceSlug: string; source: WorkspaceSourceInput }[] | null {
  if (value.workspaceSlugs.length === 0) return null
  const schema = SOURCE_SCOPES[base.provider].schema
  const requests: { workspaceSlug: string; source: WorkspaceSourceInput }[] = []
  for (const workspaceSlug of value.workspaceSlugs) {
    const scope =
      value.scopeMode === "shared" || value.workspaceSlugs.length === 1
        ? value.sharedScope
        : workspaceSlug in value.scopes
          ? value.scopes[workspaceSlug]
          : {}
    if (!scope || !schema.safeParse(scope).success) return null
    requests.push({ workspaceSlug, source: { ...base, scope } })
  }
  return requests
}

/** A source of the connection that a Workspace has now (Manage). */
export type ExistingWorkspaceSource = {
  path: string
  scope: Record<string, unknown>
}

/** The step that shows the existing sources: each Workspace with its scope. */
export function chooseWorkspacesFromExisting(
  existing: Record<string, ExistingWorkspaceSource>,
): ChooseWorkspacesValue {
  const workspaceSlugs = Object.keys(existing)
  const scopes = Object.fromEntries(
    workspaceSlugs.map((slug) => [slug, existing[slug]?.scope ?? {}]),
  )
  return {
    workspaceSlugs,
    scopeMode: workspaceSlugs.length > 1 ? "per_workspace" : "shared",
    sharedScope: existing[workspaceSlugs[0] ?? ""]?.scope ?? {},
    scopes,
  }
}

export type WorkspaceSourceChange =
  | { kind: "add"; workspaceSlug: string; source: WorkspaceSourceInput }
  | {
      kind: "update"
      workspaceSlug: string
      path: string
      source: WorkspaceSourceInput
    }
  | { kind: "remove"; workspaceSlug: string; path: string }

/** JSON with sorted object keys, so that key order is not a change. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  )
}

/**
 * The changes that make the existing sources match the step: add a new
 * Workspace, update a changed scope, and remove an unchecked Workspace.
 * `null` until each selected Workspace has a scope that the provider
 * schema accepts.
 */
export function chooseWorkspacesChanges(
  value: ChooseWorkspacesValue,
  base: { provider: SourceProvider; connectionId: string },
  existing: Record<string, ExistingWorkspaceSource>,
): WorkspaceSourceChange[] | null {
  const requests = value.workspaceSlugs.length
    ? chooseWorkspacesRequests(value, base)
    : []
  if (!requests) return null
  const changes: WorkspaceSourceChange[] = []
  for (const request of requests) {
    const current = existing[request.workspaceSlug]
    if (!current) changes.push({ kind: "add", ...request })
    else if (stableJson(current.scope) !== stableJson(request.source.scope))
      changes.push({ kind: "update", ...request, path: current.path })
  }
  for (const [workspaceSlug, current] of Object.entries(existing))
    if (!value.workspaceSlugs.includes(workspaceSlug))
      changes.push({
        kind: "remove",
        workspaceSlug,
        path: current.path,
      })
  return changes
}
