import { queryOptions } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import type {
  ConnectionUsageResponse,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
} from "backend/routes/v1/workspace-sources-contract"
import { getApiClient } from "@/lib/api"
import { pollWhileOk, readApiJson } from "@/lib/api-result"

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

/** How a change reaches the sources file: a PR (the default) or a direct commit. */
export type SourceDelivery = "pull_request" | "commit"

/** The toast after a change, true to what happens next. */
export function sourceChangeMessage(
  result: WorkspaceSourceChangeResult,
): string {
  return result.outcome === "pull_request"
    ? "Pull request opened. The change applies after the merge."
    : "Change queued. It appears after the next sync."
}

export const workspaceSourceKeys = {
  list: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-sources", orgSlug, workspaceSlug] as const,
  usage: (orgSlug: string, connectionId: string) =>
    ["connection-usage", orgSlug, connectionId] as const,
}

/** When a list of a query last had an open source pull request. */
const pendingMergeSeen = new WeakMap<
  object,
  { pending: boolean; until: number }
>()

/**
 * Refresh a list for 2 minutes after an open source pull request leaves it.
 * A merge closes the pull request about 15 s before the Workspace records
 * its source, so a read in between shows neither. Each window focus also
 * reads again: the user usually merges on GitHub in another tab.
 */
function refreshAfterMerge<T>(hasPending: (data: T) => boolean) {
  return {
    refetchOnWindowFocus: "always" as const,
    refetchInterval: (query: {
      state: { status: string; data: T | undefined }
    }) => {
      const pending =
        query.state.data !== undefined && hasPending(query.state.data)
      const seen = pendingMergeSeen.get(query) ?? { pending, until: 0 }
      if (seen.pending && !pending) seen.until = Date.now() + 120_000
      seen.pending = pending
      pendingMergeSeen.set(query, seen)
      return Date.now() < seen.until ? pollWhileOk(5_000)(query) : false
    },
  }
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
    ...refreshAfterMerge<WorkspaceSourceListResponse>(
      (data) => data.pendingChanges.length > 0,
    ),
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
    ...refreshAfterMerge<ConnectionUsageResponse>((data) =>
      data.items.some((item) => item.pendingChanges.length > 0),
    ),
  })
}

/**
 * "Sync now": queue a full sync of the connection's Workspace sources. A
 * second request in the same minute starts no other sync.
 */
export async function syncConnectionNow(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.connectors[
    ":connectionId"
  ].sync.$post({ param: { orgSlug, connectionId } })
  await readApiJson(res, { message: "Failed to start the sync" })
}

export async function createWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  source: WorkspaceSourceInput,
  delivery: SourceDelivery = "pull_request",
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.$post({
    param: { orgSlug, workspaceSlug },
    json: { source, delivery },
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
  delivery: SourceDelivery = "pull_request",
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources[":sourceKey"].$put({
    param: { orgSlug, workspaceSlug, sourceKey },
    json: { source, delivery },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to change the source",
  })
}

export async function deleteWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  sourceKey: string,
  delivery: SourceDelivery = "pull_request",
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources[":sourceKey"].$delete({
    param: { orgSlug, workspaceSlug, sourceKey },
    query: { delivery },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to remove the source",
  })
}
