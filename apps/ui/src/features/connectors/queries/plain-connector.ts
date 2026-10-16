import { apiFetch, readApiJson } from "@/lib/api-result"

export type PlainCatalogItem = { id: string; name: string }

export type PlainConnectorStatus = {
  status: "installed" | "revoked"
  workspaceName: string
  /** False when Plain refused the webhook target: no live updates. */
  webhookConfigured: boolean
}

export const plainConnectorKeys = {
  status: (orgSlug: string, connectionId: string) =>
    ["plain-connector-status", orgSlug, connectionId] as const,
  catalog: (orgSlug: string, connectionId: string) =>
    ["plain-connector-catalog", orgSlug, connectionId] as const,
}

const base = (orgSlug: string) => `/${orgSlug}/api/v1/connectors/plain`

export async function fetchPlainConnectorStatus(
  orgSlug: string,
  connectionId: string,
): Promise<PlainConnectorStatus> {
  const res = await apiFetch(
    `${base(orgSlug)}/status?${new URLSearchParams({ connectionId })}`,
    { credentials: "include" },
  )
  return readApiJson<PlainConnectorStatus>(res, {
    message: "Failed to fetch Plain connector status",
  })
}

/**
 * Check the key with Plain and save the connection. With `connectionId`,
 * replace the key of that connection (a reconnect).
 */
export async function connectPlain(
  orgSlug: string,
  body: { apiKey: string; connectionId?: string },
): Promise<{ connectionId: string }> {
  const res = await apiFetch(base(orgSlug), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return readApiJson(res, { message: "Failed to connect Plain" })
}

export async function fetchPlainCatalog(
  orgSlug: string,
  connectionId: string,
): Promise<{ helpCenters: PlainCatalogItem[]; labels: PlainCatalogItem[] }> {
  const res = await apiFetch(
    `${base(orgSlug)}/catalog?${new URLSearchParams({ connectionId })}`,
    { credentials: "include" },
  )
  return readApiJson(res, {
    message: "Failed to load Plain Help Centers and labels",
  })
}

export async function deletePlainConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await apiFetch(
    `${base(orgSlug)}?${new URLSearchParams({ connectionId })}`,
    { method: "DELETE", credentials: "include" },
  )
  await readApiJson<void>(res, {
    message: "Failed to remove the Plain connector",
  })
}
