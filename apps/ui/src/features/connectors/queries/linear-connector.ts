export type LinearScope = {
  externalId: string
  type: "team" | "project" | "document" | "initiative"
  title: string
  url?: string | null
  parentExternalId?: string | null
  teamId?: string | null
  teamKey?: string | null
}

/** The fields of the status read that the UI uses. */
export type LinearConnectorStatus = {
  isInstalled: boolean
  installationStatus: string | null
  workspaceName: string | null
}

export type LinearOauthApp = {
  linearOauthConfigured: boolean
  globalLinearOauthConfigured: boolean
  oauthCallbackUrl: string
  linearWebhookUrl: string
  linearCreateUrl: string
  oauthAppSaved: boolean
  oauthClientId: string | null
}

export const linearConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["linear-connector-status", orgSlug, connectionId ?? "default"] as const,
  allStatusForOrg: (orgSlug: string) =>
    ["linear-connector-status", orgSlug] as const,
  availableScopes: (orgSlug: string, connectionId: string) =>
    ["linear-available-scopes", orgSlug, connectionId] as const,
  oauthApp: (orgSlug: string, connectionId?: string) =>
    ["linear-oauth-app", orgSlug, connectionId ?? "default"] as const,
}

import { apiFetch, readApiJson } from "@/lib/api-result"

function connectionQuery(connectionId?: string): string {
  return connectionId
    ? `?${new URLSearchParams({ connectionId }).toString()}`
    : ""
}

export async function fetchLinearConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<LinearConnectorStatus> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/status${connectionQuery(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson<LinearConnectorStatus>(response, {
    message: "Failed to load Linear connector status",
  })
}

export async function fetchLinearAvailableScopes(
  orgSlug: string,
  connectionId: string,
): Promise<LinearScope[]> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/available-scopes${connectionQuery(connectionId)}`,
    { credentials: "include" },
  )
  const body = await readApiJson<{ items: LinearScope[] }>(response, {
    message: "Failed to discover Linear content",
  })
  return body.items
}

export async function fetchLinearOAuthStart(
  orgSlug: string,
  connectionId?: string,
): Promise<{ authorizationUrl: string }> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/oauth/start${connectionQuery(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson<{ authorizationUrl: string }>(response, {
    message: "Failed to start Linear connection",
  })
}

export async function fetchLinearOauthApp(
  orgSlug: string,
  connectionId?: string,
): Promise<LinearOauthApp> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/oauth-app${connectionQuery(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson<LinearOauthApp>(response, {
    message: "Failed to load Linear OAuth app settings",
  })
}

export async function createLinearDraft(
  orgSlug: string,
): Promise<{ connectionId: string }> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/draft`,
    {
      method: "POST",
      credentials: "include",
    },
  )
  return readApiJson<{ connectionId: string }>(response, {
    message: "Failed to start Linear setup",
  })
}

export async function saveLinearOauthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret?: string; webhookSecret?: string },
): Promise<void> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/oauth-app${connectionQuery(connectionId)}`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  await readApiJson<void>(response, {
    message: "Failed to save Linear OAuth app",
  })
}

export async function deleteLinearConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear${connectionQuery(connectionId)}`,
    { method: "DELETE", credentials: "include" },
  )
  await readApiJson<void>(response, {
    message: "Failed to remove Linear connector",
  })
}
