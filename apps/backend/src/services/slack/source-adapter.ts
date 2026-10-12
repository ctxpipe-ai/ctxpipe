import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import type {
  SourceAdapter,
  SourceFetchResult,
} from "../../domain/workspace-sources/adapter.js"
import {
  type SlackSourceScope,
  slackScopeSchema,
} from "../../domain/workspace-sources/providers/slack.js"
import {
  getSlackConnectionByConnectionId,
  type SlackConnection,
} from "../../models/slack-connector.js"
import { log } from "../../observability/logger.js"
import { gitBlobSha } from "../connectors/assets.js"
import type { GitFileChange } from "../git/file-change.js"
import { slackManagedPathsForThread } from "./assets.js"
import {
  botTokenFromConnection,
  getSlackPermalink,
  listSlackChannelThreadRoots,
  listSlackConversationReplies,
  readSlackSourceChannel,
  SlackApiError,
  SlackDirectMessageNotSupportedError,
  type SlackUserProfile,
} from "./client.js"
import {
  getSlackThreadDirPath,
  getSlackThreadPath,
  slackSourceChannelDir,
  toSlackChannelIndexFile,
} from "./converter.js"
import {
  parseSlackSourceEvent,
  type SlackSourceEvent,
  slackEventMatches,
} from "./source-event.js"
import { buildThreadFiles } from "./sync.js"

/**
 * A sync without a webhook event reads the threads of the last 30 days of
 * each channel, and at most 100 threads of a channel in one cycle. A thread
 * that each Workspace has already is not read again: a webhook event of the
 * thread keeps it current. This keeps the quota of the shared Slack app low
 * (ADR-025).
 */
const SLACK_SOURCE_BACKFILL_SECONDS = 30 * 24 * 60 * 60
const SLACK_SOURCE_MAX_THREADS = 100

/** A Slack error that does not go away when the sync tries again. */
function permanentChannelProblem(
  error: unknown,
  channel: string,
): { status: "out_of_access" | "invalid"; detail: string } | null {
  if (error instanceof SlackDirectMessageNotSupportedError)
    return { status: "invalid", detail: `${channel} is a direct message` }
  if (!(error instanceof SlackApiError)) return null
  switch (error.slackError) {
    case "channel_not_found":
      return {
        status: "out_of_access",
        detail: `Channel ${channel} is not found, or the ctx| bot cannot see it`,
      }
    case "not_in_channel":
    case "missing_scope":
      return {
        status: "out_of_access",
        detail: `Invite the ctx| bot to channel ${channel}`,
      }
    case "is_archived":
      return { status: "invalid", detail: `Channel ${channel} is archived` }
    case "method_not_supported_for_channel_type":
      return { status: "invalid", detail: `${channel} is not a channel` }
    default:
      return null
  }
}

async function loadSlackConnection(input: {
  orgId: string
  connectionId: string
}): Promise<SlackConnection> {
  const connection = await withOrgDbContext(input.orgId, () =>
    getSlackConnectionByConnectionId(input.orgId, input.connectionId),
  )
  if (!connection || connection.status !== "installed")
    throw new Error("The Slack connection is not installed")
  return connection
}

/**
 * The state of one channel of a scope, or a permanent problem. A transient
 * Slack failure throws.
 */
async function readChannel(input: {
  env: Env
  connection: SlackConnection
  channelId: string
}) {
  let info: Awaited<ReturnType<typeof readSlackSourceChannel>>
  try {
    info = await readSlackSourceChannel(input)
  } catch (error) {
    const problem = permanentChannelProblem(error, input.channelId)
    if (problem) return { problem }
    throw error
  }
  if (info.isArchived)
    return {
      problem: {
        status: "invalid" as const,
        detail: `Channel #${info.name} is archived`,
      },
    }
  if (!info.isMember)
    return {
      problem: {
        status: "out_of_access" as const,
        detail: `Invite the ctx| bot to channel #${info.name}`,
      },
    }
  return { info }
}

/** Why the bot cannot read a scope, or null. A transient failure is not a reason. */
export async function checkSlackSourceAccess(input: {
  orgId: string
  connectionId: string
  scope: SlackSourceScope
  env: Env
}): Promise<string | null> {
  const connection = await loadSlackConnection(input)
  // Check each channel: a transient failure of one channel must not hide
  // a permanent problem of another.
  for (const channelId of input.scope.channels) {
    try {
      const read = await readChannel({ env: input.env, connection, channelId })
      if (read.problem) return read.problem.detail
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

/**
 * Fetch the threads of the union of the channels as a patch: write the
 * threads that it read, delete their stale files, and keep each other file.
 * With a webhook event, read only the thread of the event.
 */
export async function fetchSlackSources(input: {
  orgId: string
  connectionId: string
  scopes: readonly SlackSourceScope[]
  env: Env
  event?: unknown
  existing?: ReadonlyArray<{ path: string; sha: string | null }>
}): Promise<SourceFetchResult> {
  const connection = await loadSlackConnection(input)
  const botToken = botTokenFromConnection(connection, input.env)
  const event: SlackSourceEvent | null = parseSlackSourceEvent(input.event)
  const channels = [...new Set(input.scopes.flatMap((s) => s.channels))]
  const existing = input.existing ?? []
  const existingPaths = existing.map((file) => file.path)
  const shaByPath = new Map(existing.map((file) => [file.path, file.sha]))
  const complete = existing.flatMap((file) =>
    file.sha ? [{ path: file.path, sha: file.sha }] : [],
  )
  const result: Required<
    Pick<SourceFetchResult, "files" | "deletePaths" | "unreachable">
  > = { files: [], deletePaths: [], unreachable: [] }
  const push = (file: GitFileChange) => {
    // The mirror write skips an unchanged blob too; this keeps the slice small.
    const sha = shaByPath.get(file.path)
    if (
      sha &&
      sha ===
        gitBlobSha(
          Buffer.from(
            file.content,
            file.encoding === "base64" ? "base64" : "utf-8",
          ),
        )
    )
      return
    result.files.push(file)
  }
  const profileCache = new Map<string, SlackUserProfile>()

  for (const channelId of channels) {
    if (event && event.channelId !== channelId) continue
    const managedPath = slackSourceChannelDir(channelId)
    const fail = (problem: {
      status: "out_of_access" | "invalid"
      detail: string
    }) => result.unreachable.push({ path: managedPath, ...problem })
    try {
      const read = await readChannel({ env: input.env, connection, channelId })
      if (read.problem) {
        fail(read.problem)
        continue
      }
      const { info } = read
      const channel = {
        layout: "source" as const,
        channelId,
        channelName: info.name,
        isPrivate: info.isPrivate,
        teamId: connection.teamId,
      }
      push(toSlackChannelIndexFile(channel))
      const roots = event
        ? [event.threadTs]
        : (
            await listSlackChannelThreadRoots({
              env: input.env,
              connection,
              channelId,
              oldest: String(
                Math.floor(Date.now() / 1000) - SLACK_SOURCE_BACKFILL_SECONDS,
              ),
              maxThreads: SLACK_SOURCE_MAX_THREADS,
            })
          ).filter(
            (threadTs) =>
              !shaByPath.get(getSlackThreadPath({ ...channel, threadTs })),
          )
      for (const threadTs of roots) {
        const threadDir = getSlackThreadDirPath({ ...channel, threadTs })
        const before = slackManagedPathsForThread(existingPaths, threadDir)
        let replies: Awaited<ReturnType<typeof listSlackConversationReplies>>
        try {
          replies = await listSlackConversationReplies({
            env: input.env,
            connection,
            channelId,
            threadTs,
          })
        } catch (error) {
          if (
            error instanceof SlackApiError &&
            error.slackError === "thread_not_found"
          ) {
            result.deletePaths.push(...before)
            continue
          }
          throw error
        }
        // The bot's own status replies are not context (ADR-025).
        const messages = replies.messages.filter(
          (message) =>
            !connection.botUserId || message.user !== connection.botUserId,
        )
        if (!messages.length) {
          result.deletePaths.push(...before)
          continue
        }
        const built = await buildThreadFiles({
          env: input.env,
          connection,
          ...channel,
          threadTs,
          permalink: await getSlackPermalink({
            env: input.env,
            connection,
            channelId,
            messageTs: threadTs,
          }),
          messages,
          truncated: replies.truncated,
          profileCache,
          botToken,
          existing: complete,
        })
        for (const file of built.files) push(file)
        const next = new Set([
          ...built.files.map((file) => file.path),
          ...built.keptPaths,
        ])
        result.deletePaths.push(...before.filter((path) => !next.has(path)))
      }
    } catch (error) {
      const problem = permanentChannelProblem(error, channelId)
      if (problem) {
        fail(problem)
        continue
      }
      // A transient failure: the patch keeps the files of this channel, and
      // the next sync tries again.
      log.warn({
        step: "slack_source.fetch_channel",
        connectionId: input.connectionId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

export const slackSourceAdapter: SourceAdapter = {
  provider: "slack",
  managedPaths: (scope) =>
    slackScopeSchema.parse(scope).channels.map(slackSourceChannelDir),
  fetch: ({ scopes, ...input }) =>
    fetchSlackSources({
      ...input,
      scopes: scopes.map((scope) => slackScopeSchema.parse(scope)),
    }),
  checkAccess: ({ scope, ...input }) =>
    checkSlackSourceAccess({ ...input, scope: slackScopeSchema.parse(scope) }),
  matchesEvent: ({ event, scope }) =>
    slackEventMatches(event, slackScopeSchema.parse(scope)),
}
