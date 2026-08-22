import { client } from "@/lib/api"
import { ApiError, apiFetch, readApiJson } from "@/lib/api-result"
import type {
  NotionConnectorConfig,
  NotionConnectorStatus,
  NotionResource,
} from "../types"

export class NotionOAuthNotConfiguredError extends Error {
  constructor() {
    super("Notion OAuth is not configured for this ctxpipe deployment.")
    this.name = "NotionOAuthNotConfiguredError"
  }
}

export const notionConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["notion-connector-status", orgSlug, connectionId ?? "default"] as const,
  config: (orgSlug: string, connectionId?: string) =>
    ["notion-connector-config", orgSlug, connectionId ?? "default"] as const,
  resources: (orgSlug: string, connectionId: string | undefined, q: string) =>
    [
      "notion-connector-resources",
      orgSlug,
      connectionId ?? "default",
      q,
    ] as const,
}

function notionConnectionQuery(connectionId?: string) {
  return connectionId ? ({ query: { connectionId } } as const) : ({} as const)
}

function notionConnectionSearch(connectionId: string): string {
  return `?${new URLSearchParams({ connectionId }).toString()}`
}

export async function fetchNotionConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<NotionConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.status.$get({
    param: { orgSlug },
    ...notionConnectionQuery(connectionId),
  })
  return readApiJson<NotionConnectorStatus>(res, {
    message: "Failed to fetch Notion connector status",
  })
}

export async function fetchNotionConnectorConfig(
  orgSlug: string,
  connectionId?: string,
): Promise<NotionConnectorConfig | null> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.config.$get({
    param: { orgSlug },
    ...notionConnectionQuery(connectionId),
  })
  return readApiJson<NotionConnectorConfig | null>(res, {
    emptyOn: [409, 404],
    empty: null,
    message: "Failed to load Notion connector config",
  })
}

export async function fetchNotionOAuthStart(
  orgSlug: string,
): Promise<{ authorizationUrl: string }> {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.notion.oauth.start.$get({
    param: { orgSlug },
  })
  try {
    return await readApiJson<{ authorizationUrl: string }>(res, {
      message: "Failed to start Notion authorization",
    })
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.body.code === "notion_oauth_not_configured"
    ) {
      throw new NotionOAuthNotConfiguredError()
    }
    throw error
  }
}

export async function searchNotionResources(
  orgSlug: string,
  q: string,
  connectionId?: string,
): Promise<NotionResource[]> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion/available-resources?${new URLSearchParams(
      {
        ...(connectionId ? { connectionId } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      },
    ).toString()}`,
    { credentials: "include" },
  )
  const json = await readApiJson<{ items: NotionResource[] }>(res, {
    message: "Failed to search Notion resources",
  })
  return json.items
}

export async function patchNotionConnectorConfig(
  orgSlug: string,
  body: { resources?: NotionResource[]; syncTarget?: unknown },
  connectionId?: string,
): Promise<{
  accepted: true
  savedCount: number
  configPrEnqueued: boolean
  workflowName?: string
}> {
  const qs = connectionId
    ? `?${new URLSearchParams({ connectionId }).toString()}`
    : ""
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion/config${qs}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  return readApiJson(res, { message: "Failed to save Notion connector config" })
}

export async function retryNotionSync(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion/retry${notionConnectionSearch(connectionId)}`,
    { method: "POST", credentials: "include" },
  )
  await readApiJson<void>(res, { message: "Failed to retry Notion sync" })
}

export async function retryNotionConfig(
  orgSlug: string,
  connectionId: string,
  resources?: NotionResource[],
): Promise<void> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion/retry-config${notionConnectionSearch(connectionId)}`,
    {
      method: "POST",
      credentials: "include",
      ...(resources
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ resources }),
          }
        : {}),
    },
  )
  await readApiJson<void>(res, {
    message: "Failed to retry Notion configuration pull request",
  })
}

export async function deleteNotionConnector(
  orgSlug: string,
  connectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.$delete({
    param: { orgSlug },
    ...notionConnectionQuery(connectionId),
  })
  await readApiJson<void>(res, { message: "Failed to remove Notion connector" })
}
