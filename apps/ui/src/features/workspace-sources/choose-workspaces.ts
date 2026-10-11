import {
  SOURCE_SCOPES,
  type SourceProvider,
} from "backend/domain/workspace-sources/sources-file"
import type { WorkspaceSourceInput } from "./queries"

/** The state of the "Choose Workspaces" wizard step. */
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
