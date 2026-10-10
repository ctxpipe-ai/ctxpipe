import { apiFetch, readApiJson } from "@/lib/api-result"
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
  webhookVerificationToken: string | null
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

function notionConnectionSearch(connectionId: string): string {
  return `?${new URLSearchParams({ connectionId }).toString()}`
}

export async function fetchNotionConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<NotionConnectorStatus> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion/status${
      connectionId ? notionConnectionSearch(connectionId) : ""
    }`,
    { credentials: "include" },
  )
  return readApiJson<NotionConnectorStatus>(res, {
    message: "Failed to fetch Notion connector status",
  })
}

export async function fetchNotionConnectorConfig(
  orgSlug: string,
  connectionId?: string,
): Promise<NotionConnectorConfig | null> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion/config${
      connectionId ? notionConnectionSearch(connectionId) : ""
    }`,
    { credentials: "include" },
  )
  return readApiJson<NotionConnectorConfig | null>(res, {
    emptyOn: [409, 404],
    empty: null,
    message: "Failed to load Notion connector config",
  })
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
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/notion${
      connectionId ? notionConnectionSearch(connectionId) : ""
    }`,
    { method: "DELETE", credentials: "include" },
  )
  await readApiJson<void>(res, { message: "Failed to remove Notion connector" })
}
