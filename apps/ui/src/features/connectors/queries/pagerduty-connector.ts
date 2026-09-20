import { client } from "@/lib/api"

export class PagerdutyOAuthNotConfiguredError extends Error {
  constructor() {
    super("PagerDuty OAuth is not configured for this ctxpipe deployment.")
    this.name = "PagerdutyOAuthNotConfiguredError"
  }
}

export type PagerdutyService = {
  id: string
  name: string
  url?: string
}

export type PagerdutyConnectorStatus = {
  isInstalled: boolean
  installationStatus: string | null
  accountName: string | null
  accountSubdomain: string | null
  region: "us" | "eu" | null
  isGithubLinked: boolean
  selectedServiceCount: number | null
  syncTargetConfigured: boolean
  setupPhase: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  syncTarget: {
    repositoryId: string
    repositoryName: string
    branch: string
    githubConnectionId: string | null
  } | null
  pagerdutyOauthConfigured: boolean
  oauthAppSaved: boolean
  globalPagerdutyOAuthConfigured: boolean
  oauthCallbackUrl: string
  webhookUrl: string
}

export type PagerdutyOAuthApp = {
  oauthAppSaved: boolean
  oauthClientId: string | null
  globalPagerdutyOAuthConfigured: boolean
  oauthCallbackUrl: string
  webhookUrl: string
}

export type PagerdutySyncTargetInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch: string
  enabled: boolean
}

export type PagerdutyConnectorConfig = {
  services: PagerdutyService[]
  syncTarget: {
    repositoryId: string
    repositoryName: string
    githubConnectionId: string | null
    branch: string
    enabled: boolean
    setupPhase: string
    pendingConfigPullUrl: string | null
    pendingConfigPrCreating: boolean
  } | null
}

export const pagerdutyConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["pagerduty-connector-status", orgSlug, connectionId ?? "default"] as const,
  config: (orgSlug: string, connectionId?: string) =>
    ["pagerduty-connector-config", orgSlug, connectionId ?? "default"] as const,
  services: (
    orgSlug: string,
    connectionId: string | undefined,
    q: string,
    offset: number,
  ) =>
    [
      "pagerduty-connector-services",
      orgSlug,
      connectionId ?? "default",
      q,
      offset,
    ] as const,
  allStatusForOrg: (orgSlug: string) =>
    ["pagerduty-connector-status", orgSlug] as const,
  oauthApp: (orgSlug: string, connectionId: string) =>
    ["pagerduty-oauth-app", orgSlug, connectionId] as const,
}

function connectionQuery(connectionId?: string) {
  return connectionId ? ({ query: { connectionId } } as const) : ({} as const)
}

export async function fetchPagerdutyConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<PagerdutyConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty.status.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  if (!res.ok) throw new Error("Failed to fetch PagerDuty connector status")
  return res.json() as Promise<PagerdutyConnectorStatus>
}

export async function fetchPagerdutyConnectorConfig(
  orgSlug: string,
  connectionId?: string,
): Promise<PagerdutyConnectorConfig | null> {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty.config.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  if (res.status === 409 || res.status === 404) return null
  if (!res.ok) throw new Error("Failed to load PagerDuty connector config")
  return res.json() as Promise<PagerdutyConnectorConfig>
}

export async function createPagerdutyDraft(
  orgSlug: string,
): Promise<{ connectionId: string }> {
  const res = await fetch(`/${orgSlug}/api/v1/connectors/pagerduty/draft`, {
    method: "POST",
    credentials: "include",
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to start PagerDuty setup")
  }
  return res.json() as Promise<{ connectionId: string }>
}

export async function fetchPagerdutyOAuthApp(
  orgSlug: string,
  connectionId: string,
): Promise<PagerdutyOAuthApp> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/oauth-app?${new URLSearchParams({ connectionId }).toString()}`,
    { credentials: "include" },
  )
  if (!res.ok) throw new Error("Failed to load PagerDuty OAuth app settings")
  return res.json() as Promise<PagerdutyOAuthApp>
}

export async function savePagerdutyOAuthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret?: string },
): Promise<PagerdutyOAuthApp> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/oauth-app?${new URLSearchParams({ connectionId }).toString()}`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errorBody.error ?? "Failed to save PagerDuty OAuth app")
  }
  return res.json() as Promise<PagerdutyOAuthApp>
}

export async function fetchPagerdutyOAuthStart(
  orgSlug: string,
  connectionId?: string,
): Promise<{ authorizationUrl: string }> {
  const qs = connectionId
    ? `?${new URLSearchParams({ connectionId }).toString()}`
    : ""
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/oauth/start${qs}`,
    { credentials: "include" },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.status === 503) throw new PagerdutyOAuthNotConfiguredError()
    throw new Error(body.error ?? "Failed to start PagerDuty authorization")
  }
  return res.json() as Promise<{ authorizationUrl: string }>
}

export async function searchPagerdutyServices(
  orgSlug: string,
  input: { q?: string; offset?: number; connectionId?: string },
): Promise<{ items: PagerdutyService[]; more: boolean }> {
  const params = new URLSearchParams()
  if (input.connectionId) params.set("connectionId", input.connectionId)
  if (input.q?.trim()) params.set("q", input.q.trim())
  if (input.offset) params.set("offset", String(input.offset))
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/available-services?${params.toString()}`,
    { credentials: "include" },
  )
  if (!res.ok) throw new Error("Failed to search PagerDuty services")
  return res.json() as Promise<{ items: PagerdutyService[]; more: boolean }>
}

export async function patchPagerdutyConnectorConfig(
  orgSlug: string,
  body: { services?: PagerdutyService[]; syncTarget?: PagerdutySyncTargetInput },
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
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/config${qs}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(
      errorBody.error ?? "Failed to save PagerDuty connector config",
    )
  }
  return res.json() as Promise<{
    accepted: true
    savedCount: number
    configPrEnqueued: boolean
    workflowName?: string
  }>
}

export async function retryPagerdutySync(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/retry?${new URLSearchParams({ connectionId }).toString()}`,
    { method: "POST", credentials: "include" },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to retry PagerDuty sync")
  }
}

export async function retryPagerdutyConfig(
  orgSlug: string,
  connectionId: string,
  services?: PagerdutyService[],
): Promise<void> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/retry-config?${new URLSearchParams({ connectionId }).toString()}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(services ? { services } : {}),
    },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to retry PagerDuty configuration")
  }
}

export async function deletePagerdutyConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/pagerduty?${new URLSearchParams({ connectionId }).toString()}`,
    { method: "DELETE", credentials: "include" },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to remove PagerDuty connector")
  }
}
