import { apiFetch, readApiJson } from "@/lib/api-result"

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
  oauthAppSaved: boolean
  globalPagerdutyOAuthConfigured: boolean
  oauthCallbackUrl: string
}

export const pagerdutyConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["pagerduty-connector-status", orgSlug, connectionId ?? "default"] as const,
  services: (orgSlug: string, connectionId: string | undefined, q: string) =>
    [
      "pagerduty-connector-services",
      orgSlug,
      connectionId ?? "default",
      q,
    ] as const,
  allStatusForOrg: (orgSlug: string) =>
    ["pagerduty-connector-status", orgSlug] as const,
}

function connectionSearch(connectionId?: string): string {
  return connectionId
    ? `?${new URLSearchParams({ connectionId }).toString()}`
    : ""
}

export async function fetchPagerdutyConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<PagerdutyConnectorStatus> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/pagerduty/status${connectionSearch(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson<PagerdutyConnectorStatus>(res, {
    message: "Failed to fetch PagerDuty connector status",
  })
}

export async function startPagerdutySetup(
  orgSlug: string,
): Promise<{ connectionId: string | null }> {
  const res = await fetch(`/${orgSlug}/api/v1/connectors/pagerduty/setup`, {
    method: "POST",
    credentials: "include",
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to start PagerDuty setup")
  }
  return res.json() as Promise<{ connectionId: string | null }>
}

export async function savePagerdutyOAuthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret: string },
): Promise<void> {
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
