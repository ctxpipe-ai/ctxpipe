export type LinearSetupPhase =
  | "draft"
  | "awaiting_merge"
  | "config_failed"
  | "initial_sync"
  | "sync_failed"
  | "live"

export type LinearScope = {
  externalId: string
  type: "team" | "project" | "document" | "initiative"
  title: string
  url?: string | null
  parentExternalId?: string | null
  teamId?: string | null
  teamKey?: string | null
}

export type LinearConnectionConfigBinding = {
  repositoryId: string
  repositoryName: string
  githubConnectionId: string | null
  branch: string
}

export type LinearConnectorStatus = {
  isInstalled: boolean
  installationStatus: string | null
  workspaceName: string | null
  isGithubLinked: boolean
  /** Null on status reads; exact scope is loaded only when setup is opened. */
  selectedScopeCount: number | null
  setupPhase: LinearSetupPhase
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  /** Wire name for the repository binding stored on `connections.config`. */
  syncTarget: LinearConnectionConfigBinding | null
}

export type LinearConnectorConfig = {
  /** Loaded from `linear/config.yaml` on the config PR or target branch. */
  scopes: LinearScope[]
  /** Wire name for the repository binding stored on `connections.config`. */
  syncTarget:
    | (LinearConnectionConfigBinding & {
        enabled: boolean
        setupPhase: LinearSetupPhase
        pendingConfigPullUrl: string | null
        pendingConfigPrCreating: boolean
      })
    | null
}

export const linearConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["linear-connector-status", orgSlug, connectionId ?? "default"] as const,
  allStatusForOrg: (orgSlug: string) =>
    ["linear-connector-status", orgSlug] as const,
  config: (orgSlug: string, connectionId?: string) =>
    ["linear-connector-config", orgSlug, connectionId ?? "default"] as const,
  allConfigForOrg: (orgSlug: string) =>
    ["linear-connector-config", orgSlug] as const,
  availableScopes: (orgSlug: string, connectionId: string) =>
    ["linear-available-scopes", orgSlug, connectionId] as const,
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

export async function fetchLinearConnectorConfig(
  orgSlug: string,
  connectionId: string,
): Promise<LinearConnectorConfig> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/config${connectionQuery(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson<LinearConnectorConfig>(response, {
    message: "Failed to load Linear connector configuration",
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
): Promise<{ authorizationUrl: string }> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/oauth/start`,
    { credentials: "include" },
  )
  return readApiJson<{ authorizationUrl: string }>(response, {
    message: "Failed to start Linear connection",
  })
}

export async function patchLinearConnectorConfig(
  orgSlug: string,
  connectionId: string,
  body: {
    scopes?: LinearScope[]
    syncTarget?: {
      repositoryId?: string
      repositoryName?: string
      gitUrl?: string
      githubConnectionId?: string
      branch: string
      enabled: boolean
    }
  },
): Promise<{
  accepted: true
  savedCount: number
  configPrEnqueued: boolean
  workflowName?: string
}> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/config${connectionQuery(connectionId)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  return readApiJson(response, {
    message: "Failed to save Linear connector configuration",
  })
}

export async function retryLinearSync(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/retry${connectionQuery(connectionId)}`,
    { method: "POST", credentials: "include" },
  )
  await readApiJson<void>(response, { message: "Failed to retry Linear sync" })
}

export async function retryLinearConfig(
  orgSlug: string,
  connectionId: string,
  scopes?: LinearScope[],
): Promise<void> {
  const response = await apiFetch(
    `/${orgSlug}/api/v1/connectors/linear/retry-config?connectionId=${encodeURIComponent(connectionId)}`,
    {
      method: "POST",
      credentials: "include",
      ...(scopes
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scopes }),
          }
        : {}),
    },
  )
  await readApiJson<void>(response, {
    message: "Failed to retry Linear configuration pull request",
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
