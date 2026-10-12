import { z } from "zod"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import {
  type SlackSourceScope,
  slackScopeSchema,
} from "../../domain/workspace-sources/providers/slack.js"
import {
  type SliceWriter,
  syncConnectionSources,
} from "../../domain/workspace-sources/sync.js"
import {
  getSlackConnectionByConnectionId,
  type SlackConnection,
} from "../../models/slack-connector.js"
import { log } from "../../observability/logger.js"
import {
  readSlackSourceChannel,
  SlackApiError,
  SlackDirectMessageNotSupportedError,
} from "./client.js"
import { slackSourceChannelDir } from "./converter.js"
import { captureSlackThreadFiles, type SlackCaptureResult } from "./sync.js"

/** The frame event of a mention capture: the channel of the thread. */
const slackCaptureEventSchema = z.object({ channelId: z.string().min(1) })

/** Why the bot cannot read a channel for good, or null. A transient failure throws. */
async function channelProblem(input: {
  env: Env
  connection: SlackConnection
  channelId: string
}): Promise<string | null> {
  const channel = input.channelId
  let info: Awaited<ReturnType<typeof readSlackSourceChannel>>
  try {
    info = await readSlackSourceChannel(input)
  } catch (error) {
    if (error instanceof SlackDirectMessageNotSupportedError)
      return `${channel} is a direct message`
    if (!(error instanceof SlackApiError)) throw error
    switch (error.slackError) {
      case "channel_not_found":
        return `Channel ${channel} is not found, or the ctx| bot cannot see it`
      case "not_in_channel":
      case "missing_scope":
        return `Invite the ctx| bot to channel ${channel}`
      case "is_archived":
        return `Channel ${channel} is archived`
      case "method_not_supported_for_channel_type":
        return `${channel} is not a channel`
      default:
        throw error
    }
  }
  if (info.isArchived) return `Channel #${info.name} is archived`
  if (!info.isMember) return `Invite the ctx| bot to channel #${info.name}`
  return null
}

/** Why the bot cannot read a scope, or null. A transient failure is not a reason. */
export async function checkSlackSourceAccess(input: {
  orgId: string
  connectionId: string
  scope: SlackSourceScope
  env: Env
}): Promise<string | null> {
  const connection = await withOrgDbContext(input.orgId, () =>
    getSlackConnectionByConnectionId(input.orgId, input.connectionId),
  )
  if (
    !connection ||
    connection.status !== "installed" ||
    !connection.botTokenEnc
  )
    return "The Slack connection is not installed. Reconnect Slack."
  // Check each channel: a transient failure of one channel must not hide
  // a permanent problem of another.
  for (const channelId of input.scope.channels) {
    try {
      const problem = await channelProblem({
        env: input.env,
        connection,
        channelId,
      })
      if (problem) return problem
    } catch (error) {
      log.warn({
        step: "slack_source.check_access",
        connectionId: input.connectionId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return null
}

export const slackSourceAdapter: SourceAdapter = {
  provider: "slack",
  managedPaths: (scope) =>
    slackScopeSchema.parse(scope).channels.map(slackSourceChannelDir),
  // A captured thread cannot be fetched again, so a removed channel keeps it.
  keepFilesOnRemove: true,
  // Slack is capture-only (ADR-025): a sync reads nothing from Slack. The
  // mention capture writes each thread through the frame with its event.
  fetch: async () => ({ files: [], deletePaths: [] }),
  checkAccess: ({ scope, ...input }) =>
    checkSlackSourceAccess({ ...input, scope: slackScopeSchema.parse(scope) }),
  matchesEvent: ({ event, scope }) =>
    slackScopeSchema
      .parse(scope)
      .channels.includes(slackCaptureEventSchema.parse(event).channelId),
}

/**
 * Capture one thread into each Workspace whose `ok` Slack source of this
 * connection has the channel (ADR-025, ADR-050). The frame writes one
 * commit for each Workspace under `slack/channels/<channelId>/`. A
 * recapture overwrites the snapshot of the thread root `ts`.
 * `no_source`: no Workspace has the channel, and nothing is written.
 */
export async function captureSlackThreadToSources(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  channelId: string
  threadTs: string
  capturedAt: string
  /** The in-thread status reply, which is not context. */
  excludeMessageTs?: string
  capturedByUserId?: string
  write: SliceWriter
  readExisting?: (
    workspaceId: string,
  ) => Promise<ReadonlyArray<{ path: string; sha: string }>>
}): Promise<
  | { kind: "no_source" }
  | { kind: "captured"; capture: SlackCaptureResult; workspaces: string[] }
> {
  const { orgId, env, connection, write, readExisting, ...thread } = input
  let capture: SlackCaptureResult | undefined
  const synced = await syncConnectionSources({
    orgId,
    connectionId: connection.id,
    env,
    write,
    readExisting,
    event: { channelId: thread.channelId },
    adapter: {
      provider: "slack",
      managedPaths: slackSourceAdapter.managedPaths,
      matchesEvent: slackSourceAdapter.matchesEvent,
      fetch: async ({ existing }) => {
        const { files, deletePaths, ...result } = await captureSlackThreadFiles(
          {
            ...thread,
            env,
            connection,
            layout: "source",
            // A path without a sha differs between the Workspaces: its
            // assets download again.
            existing: (existing ?? []).map((file) => ({
              path: file.path,
              sha: file.sha ?? "",
            })),
          },
        )
        capture = result
        return { files, deletePaths }
      },
    },
  })
  if (!capture) return { kind: "no_source" }
  return { kind: "captured", capture, workspaces: synced.workspaces }
}
