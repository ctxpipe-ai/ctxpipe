import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  SlackConnection,
  SlackSyncTarget,
} from "../../models/slack-connector.js"
import {
  CONNECTOR_ENTITY_MAX_ASSETS,
  createConnectorAssetBudget,
} from "../connectors/assets.js"
import {
  type CommitFile,
  commitFiles,
  listFilesInTree,
} from "../github/installation-write-client.js"
import {
  captureSlackThreadAssets,
  slackManagedPathsForThread,
} from "./assets.js"
import {
  botTokenFromConnection,
  fetchSlackFileInfo,
  getSlackPermalink,
  listSlackConversationReplies,
  resolveSlackChannelInfo,
  resolveSlackUserDisplayName,
  resolveSlackUserProfile,
  SlackApiError,
  type SlackApiMessage,
  SlackDirectMessageNotSupportedError,
  type SlackUserProfile,
} from "./client.js"
import {
  collectSlackMessageMedia,
  getSlackThreadDirPath,
  getSlackThreadPath,
  resolveSlackChannelPathSlug,
  type SlackCaptureAssetLink,
  type SlackCaptureMessage,
  slackMediaFromFile,
  slackMentionUserIds,
  toSlackChannelIndexFile,
  toSlackThreadMarkdownFile,
} from "./converter.js"

async function resolveRepoContextForSyncTarget(
  orgId: string,
  target: SlackSyncTarget,
): Promise<{ repositoryName: string; githubConnectionId: string }> {
  return withOrgDbContext(orgId, async () => {
    const db = getOrgDb()
    const [row] = await db
      .select({
        name: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, target.repositoryId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row?.name) {
      throw new Error("Sync target repository not found for organization")
    }
    if (!row.githubConnectionId) {
      throw new Error(
        "Sync target repository has no GitHub connection; link the repository to a GitHub installation first",
      )
    }
    return {
      repositoryName: row.name,
      githubConnectionId: row.githubConnectionId,
    }
  })
}

function githubBlobUrl(input: {
  repositoryName: string
  ref: string
  path: string
}): string | undefined {
  const name = input.repositoryName.trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return undefined
  const segments = input.path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `https://github.com/${name}/blob/${encodeURIComponent(input.ref)}/${segments}`
}

async function buildThreadCommit(input: {
  env: Env
  connection: SlackConnection
  channelId: string
  channelName: string
  pathSlug: string
  isPrivate: boolean
  teamId?: string | null
  threadTs: string
  permalink?: string | null
  capturedAt: string
  capturedBy?: SlackUserProfile | null
  messages: SlackApiMessage[]
  truncated?: boolean
  profileCache: Map<string, SlackUserProfile>
  botToken: string
  existing: Array<{ path: string; sha: string }>
}): Promise<{ files: CommitFile[]; keptPaths: string[]; threadDir: string }> {
  const threadDir = getSlackThreadDirPath(input)
  const mentionIds = new Set<string>()
  for (const message of input.messages) {
    if (message.user) mentionIds.add(message.user)
    for (const id of slackMentionUserIds(message.text ?? "")) {
      mentionIds.add(id)
    }
  }
  for (const userId of mentionIds) {
    await resolveSlackUserProfile({
      env: input.env,
      connection: input.connection,
      userId,
      cache: input.profileCache,
    })
  }

  const mentionHandles = new Map(
    [...input.profileCache.entries()].map(([userId, profile]) => [
      userId,
      profile.handle,
    ]),
  )

  const assetBudget = createConnectorAssetBudget()
  const mediaBySourceKey = new Map(
    input.messages
      .flatMap((message) => collectSlackMessageMedia(message))
      .map((media) => [media.sourceKey, media]),
  )
  for (const [sourceKey, media] of [...mediaBySourceKey.entries()].slice(
    0,
    CONNECTOR_ENTITY_MAX_ASSETS,
  )) {
    if (media.downloadUrl || !/^F[A-Z0-9]+$/i.test(sourceKey)) continue
    const remainingMs = assetBudget.deadlineAt - Date.now()
    if (remainingMs <= 0) break
    const file = await fetchSlackFileInfo({
      botToken: input.botToken,
      fileId: sourceKey,
      signal: AbortSignal.timeout(remainingMs),
    })
    const resolved = file ? slackMediaFromFile(file) : undefined
    if (resolved) {
      mediaBySourceKey.set(sourceKey, {
        ...media,
        ...resolved,
        sourceKey,
      })
    }
  }
  const captured = await captureSlackThreadAssets({
    threadDir,
    botToken: input.botToken,
    media: [...mediaBySourceKey.values()],
    existing: input.existing,
    budget: assetBudget,
  })

  const captureMessages: SlackCaptureMessage[] = []
  for (const message of input.messages) {
    const assetLinks: SlackCaptureAssetLink[] = []
    const seen = new Set<string>()
    for (const item of collectSlackMessageMedia(message)) {
      if (seen.has(item.sourceKey)) continue
      seen.add(item.sourceKey)
      const link = captured.linksBySourceKey.get(item.sourceKey)
      if (link) assetLinks.push(link)
    }
    captureMessages.push({
      ts: message.ts,
      userId: message.user,
      userDisplay: message.user
        ? await resolveSlackUserDisplayName({
            env: input.env,
            connection: input.connection,
            userId: message.user,
            cache: input.profileCache,
          })
        : undefined,
      text: message.text ?? "",
      assetLinks,
    })
  }

  const md = toSlackThreadMarkdownFile({
    channelId: input.channelId,
    channelName: input.channelName,
    pathSlug: input.pathSlug,
    isPrivate: input.isPrivate,
    teamId: input.teamId,
    threadTs: input.threadTs,
    permalink: input.permalink,
    capturedAt: input.capturedAt,
    capturedBy: input.capturedBy,
    truncated: input.truncated,
    mentionHandles,
    messages: captureMessages,
  })
  return {
    files: [{ path: md.path, content: md.content }, ...captured.files],
    keptPaths: captured.keptPaths,
    threadDir,
  }
}

export type SlackCaptureErrorCode =
  | "not_in_channel"
  | "github_protected_branch"
  | "repo_missing"
  | "dm_not_supported"
  | "capture_failed"

export type SlackCaptureResult = {
  status: "completed" | "failed"
  messageCount: number
  commitSha?: string
  /** Repo-relative path to the captured thread markdown (success only). */
  threadPath?: string
  /** GitHub blob URL for the captured markdown (success only, when resolvable). */
  githubUrl?: string
  channelName?: string
  truncated?: boolean
  errorCode?: SlackCaptureErrorCode
  error?: string
}

export function classifySlackCaptureError(
  error: unknown,
): Pick<SlackCaptureResult, "errorCode" | "error"> {
  if (error instanceof SlackDirectMessageNotSupportedError) {
    return { errorCode: "dm_not_supported", error: error.message }
  }
  if (error instanceof SlackApiError) {
    if (
      error.slackError === "not_in_channel" ||
      error.slackError === "channel_not_found" ||
      error.slackError === "missing_scope"
    ) {
      return {
        errorCode: "not_in_channel",
        error: "Bot is not in this channel",
      }
    }
    if (error.slackError === "method_not_supported_for_channel_type") {
      return { errorCode: "dm_not_supported", error: error.message }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (
    /protected branch/i.test(message) ||
    /cannot update this protected/i.test(message)
  ) {
    return { errorCode: "github_protected_branch", error: message }
  }
  if (
    /repository not found/i.test(message) ||
    /no GitHub connection/i.test(message) ||
    /GitHub installation not found/i.test(message)
  ) {
    return { errorCode: "repo_missing", error: message }
  }
  return { errorCode: "capture_failed", error: message }
}

/**
 * Snapshot-capture a single Slack thread (triggered by `app_mention`) into the
 * org's context repository. No dirty-thread tracking, no channel scope, no
 * config PR — a capture is a point-in-time export (ADR-025 §3-5).
 *
 * `excludeMessageTs` omits the in-thread status reply from the snapshot so the
 * working → captured progress message is not ingested as engineering context.
 * Recapture always writes `slack/channels/.../threads/<yyyy>/<mm>/<threadTs>/thread.md`
 * keyed on the thread root `ts`, not the mention `ts`.
 */
export async function captureSlackThread(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
  channelId: string
  threadTs: string
  excludeMessageTs?: string
  capturedByUserId?: string
}): Promise<SlackCaptureResult> {
  try {
    const { repositoryName, githubConnectionId } =
      await resolveRepoContextForSyncTarget(input.orgId, input.target)

    const channelInfo = await resolveSlackChannelInfo({
      env: input.env,
      connection: input.connection,
      channelId: input.channelId,
    })
    const channelName = channelInfo.name
    const isPrivate = channelInfo.isPrivate

    let messages: SlackApiMessage[]
    let truncated = false
    try {
      const replies = await listSlackConversationReplies({
        env: input.env,
        connection: input.connection,
        channelId: input.channelId,
        threadTs: input.threadTs,
      })
      messages = replies.messages
      truncated = replies.truncated
    } catch (error) {
      const classified = classifySlackCaptureError(error)
      return {
        status: "failed",
        messageCount: 0,
        channelName,
        ...classified,
      }
    }
    if (input.excludeMessageTs) {
      messages = messages.filter(
        (message) => message.ts !== input.excludeMessageTs,
      )
    }
    if (messages.length === 0) {
      return {
        status: "failed",
        messageCount: 0,
        channelName,
        errorCode: "capture_failed",
        error: "Slack thread has no messages to capture",
      }
    }

    const existing = await listFilesInTree({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      branch: input.target.branch,
    })

    const profileCache = new Map<string, SlackUserProfile>()
    const capturedBy = input.capturedByUserId
      ? await resolveSlackUserProfile({
          env: input.env,
          connection: input.connection,
          userId: input.capturedByUserId,
          cache: profileCache,
        })
      : undefined
    const permalink = await getSlackPermalink({
      env: input.env,
      connection: input.connection,
      channelId: input.channelId,
      messageTs: input.threadTs,
    })
    const capturedAt = new Date().toISOString()
    const botToken = botTokenFromConnection(input.connection, input.env)
    const pathSlug = resolveSlackChannelPathSlug({
      existingPaths: existing.map((file) => file.path),
      channelId: input.channelId,
      threadTs: input.threadTs,
      channelName,
    })

    const channelIndex = toSlackChannelIndexFile({
      channelId: input.channelId,
      channelName,
      pathSlug,
      isPrivate,
      teamId: input.connection.teamId,
    })
    const threadCommit = await buildThreadCommit({
      env: input.env,
      connection: input.connection,
      channelId: input.channelId,
      channelName,
      pathSlug,
      isPrivate,
      teamId: input.connection.teamId,
      threadTs: input.threadTs,
      permalink,
      capturedAt,
      capturedBy,
      messages,
      truncated,
      profileCache,
      botToken,
      existing,
    })
    const threadPath = getSlackThreadPath({
      channelId: input.channelId,
      channelName,
      pathSlug,
      threadTs: input.threadTs,
    })
    const nextPaths = new Set([
      channelIndex.path,
      ...threadCommit.files.map((file) => file.path),
      ...threadCommit.keptPaths,
    ])
    const deletePaths = slackManagedPathsForThread(
      existing.map((file) => file.path),
      threadCommit.threadDir,
    ).filter((path) => !nextPaths.has(path))

    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
      githubConnectionId,
      message: `chore(slack): capture thread ${input.threadTs} from #${channelName}`,
      files: [channelIndex, ...threadCommit.files],
      deletePaths,
    })

    return {
      status: "completed",
      messageCount: messages.length,
      commitSha: commit.commitSha,
      threadPath,
      githubUrl: githubBlobUrl({
        repositoryName,
        ref: commit.commitSha || input.target.branch,
        path: threadPath,
      }),
      channelName,
      truncated,
    }
  } catch (error) {
    return {
      status: "failed",
      messageCount: 0,
      ...classifySlackCaptureError(error),
    }
  }
}
