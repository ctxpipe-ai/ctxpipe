import { client } from "@/lib/api"
import { ApiError, readApiJson } from "@/lib/api-result"

export class NotionOAuthNotConfiguredError extends Error {
  constructor() {
    super("Notion OAuth is not configured for this ctxpipe deployment.")
    this.name = "NotionOAuthNotConfiguredError"
  }
}

export const notionConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["notion-connector-status", orgSlug, connectionId ?? "default"] as const,
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

function connectionQuery(connectionId?: string) {
  return connectionId
    ? ({ query: { connectionId } } as const)
    : ({ query: {} } as const)
}

export async function fetchNotionConnectorStatus(
  orgSlug: string,
  connectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.notion.status.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  return readApiJson(res, {
    message: "Failed to fetch Notion connector status",
  })
}

export async function createDraftNotionConnection(orgSlug: string) {
  const res = await client[":orgSlug"].api.v1.connectors.notion.draft.$post({
    param: { orgSlug },
  })
  return readApiJson(res, { message: "Failed to create Notion connection" })
}

export async function fetchNotionOauthApp(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.notion[
    "oauth-app"
  ].$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load Notion integration settings",
  })
}

export async function saveNotionOauthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret?: string },
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.notion[
    "oauth-app"
  ].$put({
    param: { orgSlug },
    query: { connectionId },
    json: body,
  })
  await readApiJson(res, { message: "Failed to save Notion integration" })
}

export async function fetchNotionOAuthStart(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.notion.oauth.start.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  try {
    return await readApiJson(res, {
      message: "Failed to start Notion authorization",
    })
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.body.code === "notion_oauth_not_configured"
    ) {
      throw new NotionOAuthNotConfiguredError()
    }
    throw error
  }
}

export async function searchNotionResources(
  orgSlug: string,
  q: string,
  connectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.notion[
    "available-resources"
  ].$get({
    param: { orgSlug },
    query: {
      ...(connectionId ? { connectionId } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
    },
  })
  const json = await readApiJson(res, {
    message: "Failed to search Notion resources",
  })
  return json.items
}

export async function deleteNotionConnector(
  orgSlug: string,
  connectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.notion.$delete({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  await readApiJson(res, { message: "Failed to remove Notion connector" })
}
