import { client } from "@/lib/api"
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

export type NotionOauthAppGet = {
  oauthConfigured: boolean
  oauthAppSaved: boolean
  oauthClientId: string | null
  webhookConfigured: boolean
  globalNotionOAuthConfigured: boolean
  callbackUrl: string
  webhookUrl: string
}

export const notionConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["notion-connector-status", orgSlug, connectionId ?? "default"] as const,
  config: (orgSlug: string, connectionId?: string) =>
    ["notion-connector-config", orgSlug, connectionId ?? "default"] as const,
  oauthApp: (orgSlug: string, connectionId: string) =>
    ["notion-oauth-app", orgSlug, connectionId] as const,
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

async function notionErrorFromResponse(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    message?: string
  }
  return new Error(body.error ?? body.message ?? fallback)
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

export async function createDraftNotionConnection(
  orgSlug: string,
): Promise<{ id: string; orgId: string }> {
  const res = await fetch(`/${orgSlug}/api/v1/connectors/notion/draft`, {
    method: "POST",
    credentials: "include",
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to create Notion connection")
  }
  return res.json() as Promise<{ id: string; orgId: string }>
}

export async function fetchNotionOauthApp(
  orgSlug: string,
  connectionId: string,
): Promise<NotionOauthAppGet> {
  const q = new URLSearchParams({ connectionId })
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/notion/oauth-app?${q.toString()}`,
    { credentials: "include" },
  )
  if (!res.ok) throw new Error("Failed to load Notion integration settings")
  return res.json() as Promise<NotionOauthAppGet>
}

export async function saveNotionOauthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret?: string },
): Promise<void> {
  const q = new URLSearchParams({ connectionId })
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/notion/oauth-app?${q.toString()}`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(json.error ?? "Failed to save Notion integration")
  }
}

export async function fetchNotionOAuthStart(
  orgSlug: string,
  connectionId?: string,
): Promise<{ authorizationUrl: string }> {
  const q = connectionId ? `?${new URLSearchParams({ connectionId })}` : ""
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/notion/oauth/start${q}`,
    { credentials: "include" },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string
      error?: string
    }
    if (body.code === "notion_oauth_not_configured") {
      throw new NotionOAuthNotConfiguredError()
    }
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

export async function retryNotionSync(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/notion/retry${notionConnectionSearch(connectionId)}`,
    { method: "POST", credentials: "include" },
  )
  if (!res.ok) {
    throw await notionErrorFromResponse(res, "Failed to retry Notion sync")
  }
}

export async function retryNotionConfig(
  orgSlug: string,
  connectionId: string,
  resources?: NotionResource[],
): Promise<void> {
  const res = await fetch(
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
  if (!res.ok) {
    throw await notionErrorFromResponse(
      res,
      "Failed to retry Notion configuration pull request",
    )
  }
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
