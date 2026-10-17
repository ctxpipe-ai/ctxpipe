import { client } from "@/lib/api"
import { ApiError, readApiJson } from "@/lib/api-result"

export type SlackSetupPhase = "draft" | "live"

export class SlackOAuthNotConfiguredError extends Error {
  constructor() {
    super("Slack OAuth is not configured for this ctxpipe deployment.")
    this.name = "SlackOAuthNotConfiguredError"
  }
}

export class SlackConnectionNotFoundError extends Error {
  constructor() {
    super("Unknown Slack connection")
    this.name = "SlackConnectionNotFoundError"
  }
}

export type SlackConnectorStatus = Awaited<
  ReturnType<typeof fetchSlackConnectorStatus>
>

export const slackConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["slack-connector-status", orgSlug, connectionId ?? "default"] as const,
  channels: (orgSlug: string, connectionId: string) =>
    ["slack-channels", orgSlug, connectionId] as const,
}

/** A channel that a Slack source can select. */
export type SlackChannel = Awaited<
  ReturnType<typeof fetchSlackChannels>
>["items"][number]

function connectionQuery(connectionId?: string) {
  return connectionId
    ? ({ query: { connectionId } } as const)
    : ({ query: {} } as const)
}

export async function fetchSlackConnectorStatus(
  orgSlug: string,
  connectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.slack.status.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  try {
    return await readApiJson(res, {
      message: "Failed to fetch Slack connector status",
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new SlackConnectionNotFoundError()
    }
    throw error
  }
}

export async function fetchSlackOAuthStart(orgSlug: string) {
  const res = await client[":orgSlug"].api.v1.connectors.slack.oauth.start.$get(
    {
      param: { orgSlug },
    },
  )
  try {
    return await readApiJson(res, {
      message: "Failed to start Slack authorization",
    })
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.body.code === "slack_oauth_not_configured"
    ) {
      throw new SlackOAuthNotConfiguredError()
    }
    throw error
  }
}

export async function deleteSlackConnector(
  orgSlug: string,
  connectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.$delete({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  await readApiJson(res, { message: "Failed to remove Slack connector" })
}

export async function fetchSlackChannels(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.slack.channels.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load the Slack channels",
  })
}
