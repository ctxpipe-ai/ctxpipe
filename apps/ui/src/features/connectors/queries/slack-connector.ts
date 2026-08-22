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

export type SlackConnectorStatus = {
  isInstalled: boolean
  installationStatus: string | null
  teamName: string | null
  botHandle: string | null
  isGithubLinked: boolean
  setupPhase: SlackSetupPhase
  syncTarget: {
    repositoryId: string
    repositoryName: string
    branch: string
    githubConnectionId: string | null
  } | null
}

export const slackConnectorKeys = {
  status: (orgSlug: string, connectionId?: string) =>
    ["slack-connector-status", orgSlug, connectionId ?? "default"] as const,
}

function connectionQuery(connectionId?: string) {
  return connectionId ? ({ query: { connectionId } } as const) : ({} as const)
}

export async function fetchSlackConnectorStatus(
  orgSlug: string,
  connectionId?: string,
): Promise<SlackConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.status.$get({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  try {
    return await readApiJson<SlackConnectorStatus>(res, {
      message: "Failed to fetch Slack connector status",
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new SlackConnectionNotFoundError()
    }
    throw error
  }
}

export async function fetchSlackOAuthStart(
  orgSlug: string,
): Promise<{ authorizationUrl: string }> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.oauth.start.$get(
    {
      param: { orgSlug },
    },
  )
  try {
    return await readApiJson<{ authorizationUrl: string }>(res, {
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

export type SlackBindRepositoryBody = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch?: string
}

export async function patchSlackConnectorConfig(
  orgSlug: string,
  body: SlackBindRepositoryBody,
  connectionId?: string,
): Promise<{ accepted: true; setupPhase: SlackSetupPhase }> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.config.$patch({
    param: { orgSlug },
    ...connectionQuery(connectionId),
    json: body,
  })
  return readApiJson<{ accepted: true; setupPhase: SlackSetupPhase }>(res, {
    message: "Failed to save Slack connector config",
  })
}

export async function deleteSlackConnector(
  orgSlug: string,
  connectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.$delete({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  await readApiJson<void>(res, { message: "Failed to remove Slack connector" })
}
