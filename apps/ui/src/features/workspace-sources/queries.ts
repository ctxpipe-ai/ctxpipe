import { queryOptions } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import type {
  ConnectionUsageResponse,
  WorkspaceSourceBatchResult,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
} from "backend/routes/v1/workspace-sources-contract"
import { getApiClient } from "@/lib/api"
import { pollWhileOk, readApiJson } from "@/lib/api-result"

export type {
  ConnectionUsageResponse,
  WorkspaceSourceBatchResult,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
}
/** One source file. `description` is the trimmed file body, when it has one. */
export type WorkspaceSource = WorkspaceSourceListResponse["items"][number]
export type PendingSourceChange =
  WorkspaceSourceListResponse["pendingChanges"][number]
export type ConnectionUsageItem = ConnectionUsageResponse["items"][number]

/** The body of an add or an edit: the front matter and the description of one source file. */
export type WorkspaceSourceInput = {
  provider: SourceProvider
  connectionId: string
  scope: Record<string, unknown>
  /** The file body. Absent keeps it on an edit; "" clears it. */
  description?: string
}

/** The toast after a change, true to what happens next. */
export function sourceChangeMessage(): string {
  return "Pull request opened. The change applies after the merge."
}

export const workspaceSourceKeys = {
  list: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-sources", orgSlug, workspaceSlug] as const,
  usage: (orgSlug: string, connectionId: string) =>
    ["connection-usage", orgSlug, connectionId] as const,
}

/** The open source pull requests that a query last listed. */
const pendingMergeSeen = new WeakMap<
  object,
  { open: Set<string>; until: number }
>()

/**
 * Refresh a list for 2 minutes after an open source pull request leaves it.
 * A merge closes the pull request about 15 s before the Workspace records
 * its source, so a read in between shows neither. While a pull request is
 * open, each window focus also reads again: the user usually merges it on
 * GitHub in another tab.
 */
function refreshAfterMerge<T>(pullRequestUrls: (data: T) => string[]) {
  const openUrls = (query: { state: { data: T | undefined } }) =>
    query.state.data === undefined ? [] : pullRequestUrls(query.state.data)
  return {
    refetchOnWindowFocus: (query: { state: { data: T | undefined } }) =>
      openUrls(query).length > 0 ? ("always" as const) : true,
    refetchInterval: (query: {
      state: { status: string; data: T | undefined }
    }) => {
      const open = new Set(openUrls(query))
      const seen = pendingMergeSeen.get(query) ?? { open, until: 0 }
      if ([...seen.open].some((url) => !open.has(url)))
        seen.until = Date.now() + 120_000
      seen.open = open
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
    ...refreshAfterMerge<WorkspaceSourceListResponse>((data) =>
      data.pendingChanges.map((change) => change.pullRequestUrl),
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
      data.items.flatMap((item) =>
        item.pendingChanges.map((change) => change.pullRequestUrl),
      ),
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
  /** The file path. Without it, the server names the file. */
  path?: string,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.$post({
    param: { orgSlug, workspaceSlug },
    json: { path, source },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to add the source",
  })
}

/** Add several sources in one pull request (or one commit). One refused source refuses all. */
export async function createWorkspaceSourcesBatch(
  orgSlug: string,
  workspaceSlug: string,
  sources: { path?: string; source: WorkspaceSourceInput }[],
): Promise<WorkspaceSourceBatchResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.batch.$post({
    param: { orgSlug, workspaceSlug },
    json: { sources },
  })
  return readApiJson<WorkspaceSourceBatchResult>(res, {
    message: "Failed to add the sources",
  })
}

export async function updateWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  path: string,
  source: WorkspaceSourceInput,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.$put({
    param: { orgSlug, workspaceSlug },
    json: { path, source },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to change the source",
  })
}

export async function renameWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  path: string,
  newPath: string,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.rename.$post({
    param: { orgSlug, workspaceSlug },
    json: { path, newPath },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to rename the source",
  })
}

export async function deleteWorkspaceSource(
  orgSlug: string,
  workspaceSlug: string,
  path: string,
): Promise<WorkspaceSourceChangeResult> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].sources.$delete({
    param: { orgSlug, workspaceSlug },
    query: { path },
  })
  return readApiJson<WorkspaceSourceChangeResult>(res, {
    message: "Failed to remove the source",
  })
}
