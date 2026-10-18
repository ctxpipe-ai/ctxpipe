import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export type BuildkitePipeline = Awaited<
  ReturnType<typeof fetchBuildkitePipelines>
>["items"][number]

export type BuildkiteConnectorStatus = Awaited<
  ReturnType<typeof fetchBuildkiteConnectorStatus>
>

export const buildkiteConnectorKeys = {
  status: (orgSlug: string, connectionId: string) =>
    ["buildkite-connector-status", orgSlug, connectionId] as const,
  pipelines: (orgSlug: string, connectionId: string) =>
    ["buildkite-connector-pipelines", orgSlug, connectionId] as const,
}

const buildkite = () => client[":orgSlug"].api.v1.connectors.buildkite

export async function fetchBuildkiteConnectorStatus(
  orgSlug: string,
  connectionId: string,
) {
  const res = await buildkite().status.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
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
) {
  const res = await buildkite().$post({ param: { orgSlug }, json: body })
  return readApiJson(res, { message: "Failed to connect Buildkite" })
}

export async function saveBuildkiteWebhookToken(
  orgSlug: string,
  body: { connectionId: string; webhookToken: string },
): Promise<void> {
  const res = await buildkite()["webhook-token"].$put({
    param: { orgSlug },
    json: body,
  })
  await readApiJson(res, { message: "Failed to save the webhook token" })
}

export async function fetchBuildkitePipelines(
  orgSlug: string,
  connectionId: string,
) {
  const res = await buildkite().pipelines.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, { message: "Failed to load Buildkite pipelines" })
}

export async function deleteBuildkiteConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await buildkite().$delete({
    param: { orgSlug },
    query: { connectionId },
  })
  await readApiJson(res, {
    message: "Failed to remove the Buildkite connector",
  })
}
