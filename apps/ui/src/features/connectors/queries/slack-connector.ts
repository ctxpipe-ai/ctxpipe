import { client } from "@/lib/api"

export type SlackSetupPhase = "draft" | "live"

export class SlackOAuthNotConfiguredError extends Error {
  constructor() {
    super("Slack OAuth is not configured for this ctxpipe deployment.")
    this.name = "SlackOAuthNotConfiguredError"
  }
}

export type SlackConnectorStatus = {
  isInstalled: boolean
  installationStatus: string | null
  teamName: string | null
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
  if (!res.ok) throw new Error("Failed to fetch Slack connector status")
  return res.json() as Promise<SlackConnectorStatus>
}

export async function fetchSlackOAuthStart(
  orgSlug: string,
): Promise<{ authorizationUrl: string }> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.oauth.start.$get(
    {
      param: { orgSlug },
    },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string
      error?: string
    }
    if (body.code === "slack_oauth_not_configured") {
      throw new SlackOAuthNotConfiguredError()
    }
    throw new Error(body.error ?? "Failed to start Slack authorization")
  }
  return res.json() as Promise<{ authorizationUrl: string }>
}

export async function patchSlackConnectorConfig(
  orgSlug: string,
  body: { repositoryId: string },
  connectionId?: string,
): Promise<{ accepted: true; setupPhase: SlackSetupPhase }> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.config.$patch({
    param: { orgSlug },
    ...connectionQuery(connectionId),
    json: body,
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to save Slack connector config")
  }
  return res.json() as Promise<{ accepted: true; setupPhase: SlackSetupPhase }>
}

export async function deleteSlackConnector(
  orgSlug: string,
  connectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.slack.$delete({
    param: { orgSlug },
    ...connectionQuery(connectionId),
  })
  if (!res.ok && res.status !== 204) {
    throw new Error("Failed to remove Slack connector")
  }
}
