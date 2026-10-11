import type { WorkspaceRecord } from "../../models/workspaces.js"
import type {
  ConnectionUsageResponse,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
} from "../../routes/v1/workspace-sources-contract.js"
import type { SourceProvider } from "./sources-file.js"

export type SourceChange =
  | {
      action: "add"
      sourceKey?: string
      provider: SourceProvider
      connectionId: string
      scope: Record<string, unknown>
    }
  | {
      action: "edit"
      sourceKey: string
      provider: SourceProvider
      connectionId: string
      scope: Record<string, unknown>
    }
  | { action: "remove"; sourceKey: string }

/** A change that the route maps to an HTTP error. */
export class SourceChangeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

export async function listWorkspaceSources(
  _workspace: WorkspaceRecord,
): Promise<WorkspaceSourceListResponse> {
  throw new Error("listWorkspaceSources is not implemented")
}

export async function changeWorkspaceSource(_input: {
  workspace: WorkspaceRecord
  change: SourceChange
  delivery: "pull_request" | "commit"
}): Promise<WorkspaceSourceChangeResult> {
  throw new Error("changeWorkspaceSource is not implemented")
}

export async function listConnectionUsage(
  _connectionId: string,
): Promise<ConnectionUsageResponse | null> {
  throw new Error("listConnectionUsage is not implemented")
}
