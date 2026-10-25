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
  resolveSlackChannelInfo,
  SlackApiError,
  SlackDirectMessageNotSupportedError,
} from "./client.js"
import { slackSourceChannelDir } from "./converter.js"
import { captureSlackThreadFiles, type SlackCaptureResult } from "./sync.js"

/** The frame event of a mention capture: the channel of the thread. */
const slackCaptureEventSchema = z.object({ channelId: z.string().min(1) })

/**
 * Why the bot cannot read a channel, or null. `invite`: the bot is not in the
 * channel. That does not block the source, because Slack sends a mention only
 * from a channel that the bot is in, and an invite changes nothing in ctxpipe.
 * A transient failure throws.
 */
async function channelProblem(input: {
  env: Env
  connection: SlackConnection
  channelId: string
}): Promise<{ text: string; invite?: true } | null> {
  const channel = input.channelId
  let info: Awaited<ReturnType<typeof resolveSlackChannelInfo>>
  try {
    info = await resolveSlackChannelInfo(input)
  } catch (error) {
    if (error instanceof SlackDirectMessageNotSupportedError)
      return { text: `${channel} is a direct message` }
    if (!(error instanceof SlackApiError)) throw error
    switch (error.slackError) {
      case "channel_not_found":
        return {
          text: `Channel ${channel} is not found, or the ctxpipe bot cannot see it`,
        }
      case "not_in_channel":
        return {
          text: `Invite the ctxpipe bot to channel ${channel}`,
          invite: true,
        }
      case "missing_scope":
        return {
          text: `The ctxpipe Slack app needs a scope to read channel ${channel}. Reinstall Slack.`,
        }
      case "is_archived":
        return { text: `Channel ${channel} is archived` }
      case "method_not_supported_for_channel_type":
        return { text: `${channel} is not a channel` }
      default:
        throw error
    }
  }
  if (info.isArchived) return { text: `Channel #${info.name} is archived` }
  if (!info.isMember)
    return {
      text: `Invite the ctxpipe bot to channel #${info.name}`,
      invite: true,
    }
  return null
}

/**
 * Why the bot cannot read a scope. A string: no channel is usable, so the
 * source is out of access. `okDetail`: some channels are usable, so the
 * source stays `ok` and the detail names the others. A channel without the
 * bot, or with a transient failure, counts as usable.
 */
async function checkSlackSourceAccess(input: {
  orgId: string
  connectionId: string
  scope: SlackSourceScope
  env: Env
}): Promise<string | { okDetail: string } | null> {
  const connection = await withOrgDbContext(input.orgId, () =>
    getSlackConnectionByConnectionId(input.orgId, input.connectionId),
  )
  if (
    !connection ||
    connection.status !== "installed" ||
    !connection.botTokenEnc
  )
    return "The Slack connection is not installed. Reconnect Slack."
  const problems: string[] = []
  let blocked = 0
  for (const channelId of input.scope.channels) {
    try {
      const problem = await channelProblem({
        env: input.env,
        connection,
        channelId,
      })
      if (problem) problems.push(problem.text)
      if (problem && !problem.invite) blocked += 1
    } catch (error) {
      log.warn({
        step: "slack_source.check_access",
        connectionId: input.connectionId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (!problems.length) return null
  const detail = problems.join("; ")
  return blocked === input.scope.channels.length ? detail : { okDetail: detail }
}

export const slackSourceAdapter = {
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
} satisfies SourceAdapter

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
  readExisting?: Parameters<typeof syncConnectionSources>[0]["readExisting"]
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
      ...slackSourceAdapter,
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
