import { apiFetch, readApiJson } from "@/lib/api-result"

export type ZendeskConnectorStatus = {
  status: "pending" | "installed" | "revoked"
  subdomain: string
  oauthClientConfigured: boolean
  /** Hosted ctx| has a Zendesk global OAuth client. */
  deploymentOAuthClient: boolean
  /** Register this redirect URL on a local OAuth client. */
  redirectUri: string
  webhookConfigured: boolean
}

export type ZendeskCatalog = {
  categories: Array<{ id: string; name: string }>
  views: Array<{ id: string; title: string }>
}

export const zendeskConnectorKeys = {
  status: (orgSlug: string, connectionId: string) =>
    ["zendesk-connector-status", orgSlug, connectionId] as const,
  catalog: (orgSlug: string, connectionId: string) =>
    ["zendesk-connector-catalog", orgSlug, connectionId] as const,
}

const base = (orgSlug: string) => `/${orgSlug}/api/v1/connectors/zendesk`
const jsonHeaders = { "content-type": "application/json" }
const withConnection = (connectionId: string) =>
  `?${new URLSearchParams({ connectionId })}`

export async function fetchZendeskConnectorStatus(
  orgSlug: string,
  connectionId: string,
): Promise<ZendeskConnectorStatus> {
  const res = await apiFetch(
    `${base(orgSlug)}/status${withConnection(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson<ZendeskConnectorStatus>(res, {
    message: "Failed to fetch Zendesk connector status",
  })
}

/** Start a setup for a subdomain. A pending setup of it is used again. */
export async function startZendeskSetup(
  orgSlug: string,
  subdomain: string,
): Promise<{ connectionId: string }> {
  const res = await apiFetch(base(orgSlug), {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ subdomain }),
  })
  return readApiJson(res, { message: "Failed to start the Zendesk setup" })
}

export async function saveZendeskOAuthClient(
  orgSlug: string,
  body: { connectionId: string; clientId: string; clientSecret: string },
): Promise<void> {
  const res = await apiFetch(`${base(orgSlug)}/oauth-client`, {
    method: "PUT",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  await readApiJson<void>(res, {
    message: "Failed to save the Zendesk OAuth client",
  })
}

export async function fetchZendeskOAuthStart(
  orgSlug: string,
  connectionId: string,
): Promise<{ authorizationUrl: string }> {
  const res = await apiFetch(
    `${base(orgSlug)}/oauth/start${withConnection(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson(res, { message: "Failed to start Zendesk authorization" })
}

export async function fetchZendeskCatalog(
  orgSlug: string,
  connectionId: string,
): Promise<ZendeskCatalog> {
  const res = await apiFetch(
    `${base(orgSlug)}/catalog${withConnection(connectionId)}`,
    { credentials: "include" },
  )
  return readApiJson(res, {
    message: "Failed to load Zendesk categories and views",
  })
}

export async function deleteZendeskConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await apiFetch(
    `${base(orgSlug)}${withConnection(connectionId)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  )
  await readApiJson<void>(res, {
    message: "Failed to remove the Zendesk connector",
  })
}
