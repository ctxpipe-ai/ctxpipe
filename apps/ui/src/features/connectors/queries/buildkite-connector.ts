import { apiFetch, readApiJson } from "@/lib/api-result"

export type BuildkitePipeline = { slug: string; name: string }

export type BuildkiteConnectorStatus = {
  status: "installed" | "revoked"
  organizationSlug: string
  /** Add a webhook with this URL in Buildkite. */
  webhookUrl: string
  webhookConfigured: boolean
}

export const buildkiteConnectorKeys = {
  status: (orgSlug: string, connectionId: string) =>
    ["buildkite-connector-status", orgSlug, connectionId] as const,
  pipelines: (orgSlug: string, connectionId: string) =>
    ["buildkite-connector-pipelines", orgSlug, connectionId] as const,
}

const base = (orgSlug: string) => `/${orgSlug}/api/v1/connectors/buildkite`
const jsonHeaders = { "content-type": "application/json" }

export async function fetchBuildkiteConnectorStatus(
  orgSlug: string,
  connectionId: string,
): Promise<BuildkiteConnectorStatus> {
  const res = await apiFetch(
    `${base(orgSlug)}/status?${new URLSearchParams({ connectionId })}`,
    { credentials: "include" },
  )
  return readApiJson<BuildkiteConnectorStatus>(res, {
    message: "Failed to fetch Buildkite connector status",
  })
}

/**
 * Check the token with Buildkite and save the connection. With
 * `connectionId`, replace the token of that connection (a reconnect).
 */
export async function connectBuildkite(
  orgSlug: string,
  body: {
    organizationSlug: string
    apiToken: string
    connectionId?: string
  },
): Promise<{ connectionId: string }> {
  const res = await apiFetch(base(orgSlug), {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  return readApiJson<{ connectionId: string }>(res, {
    message: "Failed to connect Buildkite",
  })
}

export async function saveBuildkiteWebhookToken(
  orgSlug: string,
  body: { connectionId: string; webhookToken: string },
): Promise<void> {
  const res = await apiFetch(`${base(orgSlug)}/webhook-token`, {
    method: "PUT",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  await readApiJson<void>(res, { message: "Failed to save the webhook token" })
}

export async function fetchBuildkitePipelines(
  orgSlug: string,
  connectionId: string,
): Promise<{ items: BuildkitePipeline[]; truncated: boolean }> {
  const res = await apiFetch(
    `${base(orgSlug)}/pipelines?${new URLSearchParams({ connectionId })}`,
    { credentials: "include" },
  )
  return readApiJson(res, { message: "Failed to load Buildkite pipelines" })
}

export async function deleteBuildkiteConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await apiFetch(
    `${base(orgSlug)}?${new URLSearchParams({ connectionId })}`,
    { method: "DELETE", credentials: "include" },
  )
  await readApiJson<void>(res, {
    message: "Failed to remove the Buildkite connector",
  })
}
