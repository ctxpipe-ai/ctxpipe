import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

type LinearScopeRead = Awaited<
  ReturnType<typeof fetchLinearAvailableScopes>
>[number]

/** The optional fields are absent in a scope that has no parent, team, or link. */
export type LinearScope = Omit<
  LinearScopeRead,
  "url" | "parentExternalId" | "teamId" | "teamKey"
> &
  Partial<
    Pick<LinearScopeRead, "url" | "parentExternalId" | "teamId" | "teamKey">
  >

/** The fields of the status read that the UI uses. */
export type LinearConnectorStatus = Pick<
  Awaited<ReturnType<typeof fetchLinearConnectorStatus>>,
  "isInstalled" | "installationStatus" | "workspaceName"
>

export type LinearOauthApp = Awaited<ReturnType<typeof fetchLinearOauthApp>>

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

function connectionQuery(connectionId?: string) {
  return connectionId
    ? ({ query: { connectionId } } as const)
    : ({ query: {} } as const)
}

export async function fetchLinearConnectorStatus(
  orgSlug: string,
  connectionId?: string,
) {
  const response = await client[
    ":orgSlug"
  ].api.v1.connectors.linear.status.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  return readApiJson(response, {
    message: "Failed to load Linear connector status",
  })
}

export async function fetchLinearAvailableScopes(
  orgSlug: string,
  connectionId: string,
) {
  const response = await client[":orgSlug"].api.v1.connectors.linear[
    "available-scopes"
  ].$get({
    param: { orgSlug },
    query: { connectionId },
  })
  const body = await readApiJson(response, {
    message: "Failed to discover Linear content",
  })
  return body.items
}

export async function fetchLinearOAuthStart(
  orgSlug: string,
  connectionId?: string,
) {
  const response = await client[
    ":orgSlug"
  ].api.v1.connectors.linear.oauth.start.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  return readApiJson(response, {
    message: "Failed to start Linear connection",
  })
}

export async function fetchLinearOauthApp(
  orgSlug: string,
  connectionId?: string,
) {
  const response = await client[":orgSlug"].api.v1.connectors.linear[
    "oauth-app"
  ].$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  return readApiJson(response, {
    message: "Failed to load Linear OAuth app settings",
  })
}

export async function createLinearDraft(orgSlug: string) {
  const response = await client[
    ":orgSlug"
  ].api.v1.connectors.linear.draft.$post({
    param: { orgSlug },
  })
  return readApiJson(response, {
    message: "Failed to start Linear setup",
  })
}

export async function saveLinearOauthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret?: string; webhookSecret?: string },
): Promise<void> {
  const response = await client[":orgSlug"].api.v1.connectors.linear[
    "oauth-app"
  ].$put({
    param: { orgSlug },
    query: { connectionId },
    json: body,
  })
  await readApiJson(response, {
    message: "Failed to save Linear OAuth app",
  })
}

export async function deleteLinearConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const response = await client[":orgSlug"].api.v1.connectors.linear.$delete({
    param: { orgSlug },
    query: { connectionId },
  })
  await readApiJson(response, {
    message: "Failed to remove Linear connector",
  })
}
