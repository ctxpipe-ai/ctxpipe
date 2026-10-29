import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export type PlainConnectorStatus = Awaited<
  ReturnType<typeof fetchPlainConnectorStatus>
>

export type PlainCatalogItem = Awaited<
  ReturnType<typeof fetchPlainCatalog>
>["helpCenters"][number]

export const plainConnectorKeys = {
  status: (orgSlug: string, connectionId: string) =>
    ["plain-connector-status", orgSlug, connectionId] as const,
  catalog: (orgSlug: string, connectionId: string) =>
    ["plain-connector-catalog", orgSlug, connectionId] as const,
}

export async function fetchPlainConnectorStatus(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.plain.status.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
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
) {
  const res = await client[":orgSlug"].api.v1.connectors.plain.$post({
    param: { orgSlug },
    json: body,
  })
  return readApiJson(res, { message: "Failed to connect Plain" })
}

export async function fetchPlainCatalog(orgSlug: string, connectionId: string) {
  const res = await client[":orgSlug"].api.v1.connectors.plain.catalog.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load Plain Help Centers and labels",
  })
}

export async function deletePlainConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.plain.$delete({
    param: { orgSlug },
    query: { connectionId },
  })
  await readApiJson(res, {
    message: "Failed to remove the Plain connector",
  })
}
