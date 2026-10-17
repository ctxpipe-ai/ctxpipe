import { client } from "@/lib/api"
import { ApiError, readApiJson } from "@/lib/api-result"

export class PagerdutyOAuthNotConfiguredError extends Error {
  constructor() {
    super("PagerDuty OAuth is not configured for this ctxpipe deployment.")
    this.name = "PagerdutyOAuthNotConfiguredError"
  }
}

export type PagerdutyService = Awaited<
  ReturnType<typeof searchPagerdutyServices>
>["items"][number]

export type PagerdutyConnectorStatus = Awaited<
  ReturnType<typeof fetchPagerdutyConnectorStatus>
>

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

function connectionQuery(connectionId?: string) {
  return connectionId
    ? ({ query: { connectionId } } as const)
    : ({ query: {} } as const)
}

export async function fetchPagerdutyConnectorStatus(
  orgSlug: string,
  connectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty.status.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  return readApiJson(res, {
    message: "Failed to fetch PagerDuty connector status",
  })
}

export async function startPagerdutySetup(orgSlug: string) {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty.setup.$post({
    param: { orgSlug },
  })
  return readApiJson(res, { message: "Failed to start PagerDuty setup" })
}

export async function savePagerdutyOAuthApp(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret: string },
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty[
    "oauth-app"
  ].$put({
    param: { orgSlug },
    query: { connectionId },
    json: body,
  })
  await readApiJson(res, { message: "Failed to save PagerDuty OAuth app" })
}

export async function fetchPagerdutyOAuthStart(
  orgSlug: string,
  connectionId?: string,
) {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.pagerduty.oauth.start.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  try {
    return await readApiJson(res, {
      message: "Failed to start PagerDuty authorization",
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      throw new PagerdutyOAuthNotConfiguredError()
    }
    throw error
  }
}

export async function searchPagerdutyServices(
  orgSlug: string,
  input: { q?: string; offset?: number; connectionId?: string },
) {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty[
    "available-services"
  ].$get({
    param: { orgSlug },
    query: {
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.q?.trim() ? { q: input.q.trim() } : {}),
      ...(input.offset ? { offset: String(input.offset) } : {}),
    },
  })
  return readApiJson(res, { message: "Failed to search PagerDuty services" })
}

export async function deletePagerdutyConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.pagerduty.$delete({
    param: { orgSlug },
    query: { connectionId },
  })
  await readApiJson(res, { message: "Failed to remove PagerDuty connector" })
}
