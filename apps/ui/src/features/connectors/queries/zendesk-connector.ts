import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export type ZendeskConnectorStatus = Awaited<
  ReturnType<typeof fetchZendeskConnectorStatus>
>

export type ZendeskCatalog = Awaited<ReturnType<typeof fetchZendeskCatalog>>

export const zendeskConnectorKeys = {
  status: (orgSlug: string, connectionId: string) =>
    ["zendesk-connector-status", orgSlug, connectionId] as const,
  catalog: (orgSlug: string, connectionId: string) =>
    ["zendesk-connector-catalog", orgSlug, connectionId] as const,
}

export async function fetchZendeskConnectorStatus(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.zendesk.status.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to fetch Zendesk connector status",
  })
}

/** Start a setup for a subdomain. A pending setup of it is used again. */
export async function startZendeskSetup(orgSlug: string, subdomain: string) {
  const res = await client[":orgSlug"].api.v1.connectors.zendesk.$post({
    param: { orgSlug },
    json: { subdomain },
  })
  return readApiJson(res, { message: "Failed to start the Zendesk setup" })
}

export async function saveZendeskOAuthClient(
  orgSlug: string,
  body: { connectionId: string; clientId: string; clientSecret: string },
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.zendesk[
    "oauth-client"
  ].$put({
    param: { orgSlug },
    json: body,
  })
  await readApiJson(res, {
    message: "Failed to save the Zendesk OAuth client",
  })
}

export async function fetchZendeskOAuthStart(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.zendesk.oauth.start.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, { message: "Failed to start Zendesk authorization" })
}

export async function fetchZendeskCatalog(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.zendesk.catalog.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load Zendesk categories and views",
  })
}

export async function deleteZendeskConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.zendesk.$delete({
    param: { orgSlug },
    query: { connectionId },
  })
  await readApiJson(res, {
    message: "Failed to remove the Zendesk connector",
  })
}
