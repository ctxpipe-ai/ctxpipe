import { queryOptions } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import type {
  ConnectionUsageResponse,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
} from "backend/routes/v1/workspace-sources-contract"
import { getApiClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export type {
  ConnectionUsageResponse,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
}
export type WorkspaceSource = WorkspaceSourceListResponse["items"][number]
export type PendingSourceChange =
  WorkspaceSourceListResponse["pendingChanges"][number]
export type ConnectionUsageItem = ConnectionUsageResponse["items"][number]

/** The body of an add or an edit: one entry of `.ctxpipe/sources.yaml`. */
export type WorkspaceSourceInput = {
  provider: SourceProvider
  connectionId: string
  scope: Record<string, unknown>
}

export const workspaceSourceKeys = {
  list: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-sources", orgSlug, workspaceSlug] as const,
  usage: (orgSlug: string, connectionId: string) =>
    ["connection-usage", orgSlug, connectionId] as const,
}

export function workspaceSourcesOptions(
  orgSlug: string,
  workspaceSlug: string,
) {
  return queryOptions({
    queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
    queryFn: async (): Promise<WorkspaceSourceListResponse> => {
      const client = await getApiClient()
      const res = await client[":orgSlug"].api.v1.workspaces[
        ":workspaceSlug"
      ].sources.$get({ param: { orgSlug, workspaceSlug } })
      return readApiJson<WorkspaceSourceListResponse>(res, {
        message: "Failed to load Workspace sources",
      })
    },
  })
}

export function connectionUsageOptions(orgSlug: string, connectionId: string) {
  return queryOptions({
    queryKey: workspaceSourceKeys.usage(orgSlug, connectionId),
    queryFn: async (): Promise<ConnectionUsageResponse> => {
      const client = await getApiClient()
      const res = await client[":orgSlug"].api.v1.connectors[
        ":connectionId"
      ].workspaces.$get({ param: { orgSlug, connectionId } })
      return readApiJson<ConnectionUsageResponse>(res, {
        message: "Failed to load the Workspaces of this connector",
      })
    },
  })
}

export async function createWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  source: WorkspaceSourceInput,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.$post({
    param: { orgSlug, workspaceSlug },
    json: { source, delivery: "pull_request" },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to add the source",
  })
}

export async function updateWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  sourceKey: string,
  source: WorkspaceSourceInput,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources[":sourceKey"].$put({
    param: { orgSlug, workspaceSlug, sourceKey },
    json: { source, delivery: "pull_request" },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to change the source",
  })
}

export async function deleteWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  sourceKey: string,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources[":sourceKey"].$delete({
    param: { orgSlug, workspaceSlug, sourceKey },
    query: { delivery: "pull_request" },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to remove the source",
  })
}
