import { client } from "@/lib/api"
import type {
  NotionConnectorConfig,
  NotionConnectorStatus,
  NotionResource,
} from "../types"

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

export async function fetchNotionConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<NotionConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.status.$get({
    param: { orgSlug },
    ...notionConnectionQuery(connectionId),
  })
  if (!res.ok) throw new Error("Failed to fetch Notion connector status")
  return res.json() as Promise<NotionConnectorStatus>
}

export async function fetchNotionConnectorConfig(
  orgSlug: string,
  connectionId?: string,
): Promise<NotionConnectorConfig | null> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.config.$get({
    param: { orgSlug },
    ...notionConnectionQuery(connectionId),
  })
  if (res.status === 409 || res.status === 404) return null
  if (!res.ok) throw new Error("Failed to load Notion connector config")
  return res.json() as Promise<NotionConnectorConfig>
}

export async function fetchNotionOAuthStart(
  orgSlug: string,
): Promise<{ authorizationUrl: string }> {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.notion.oauth.start.$get({
    param: { orgSlug },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to start Notion authorization")
  }
  return res.json() as Promise<{ authorizationUrl: string }>
}

export async function searchNotionResources(
  orgSlug: string,
  q: string,
  connectionId?: string,
): Promise<NotionResource[]> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/notion/available-resources?${new URLSearchParams(
      {
        ...(connectionId ? { connectionId } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      },
    ).toString()}`,
    { credentials: "include" },
  )
  if (!res.ok) throw new Error("Failed to search Notion resources")
  const json = (await res.json()) as { items: NotionResource[] }
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
  const res = await fetch(`/${orgSlug}/api/v1/connectors/notion/config${qs}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to save Notion connector config")
  }
  return res.json() as Promise<{
    accepted: true
    savedCount: number
    configPrEnqueued: boolean
    workflowName?: string
  }>
}

export async function deleteNotionConnector(
  orgSlug: string,
  connectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.$delete({
    param: { orgSlug },
    ...notionConnectionQuery(connectionId),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to remove Notion connector")
  }
}
