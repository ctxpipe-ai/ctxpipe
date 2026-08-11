import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  SlackConnection,
  SlackSyncTarget,
} from "../../models/slack-connector.js"
import { commitFiles } from "../github/installation-write-client.js"
import {
  listSlackConversationReplies,
  resolveSlackChannelInfo,
  resolveSlackUserDisplayName,
  type SlackApiMessage,
} from "./client.js"
import {
  getSlackThreadPath,
  type SlackMirrorMessage,
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

/** Prefer durable Slack UI links over auth-gated private download URLs. */
function slackFileStubLink(file: {
  id: string
  permalink?: string
  permalink_public?: string
  url_private?: string
}): string {
  const permalink = file.permalink?.trim()
  if (permalink) return permalink
  const publicPermalink = file.permalink_public?.trim()
  if (publicPermalink) return publicPermalink
  const privateUrl = file.url_private?.trim()
  if (privateUrl) return privateUrl
  return `#file-${file.id}`
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

async function buildThreadFiles(input: {
  env: Env
  connection: SlackConnection
  channelId: string
  channelName: string
  isPrivate: boolean
  teamId?: string | null
  threadTs: string
  messages: SlackApiMessage[]
  userCache: Map<string, string>
}): Promise<Array<{ path: string; content: string }>> {
  const mirrorMessages: SlackMirrorMessage[] = []

  for (const message of input.messages) {
    const userDisplay = message.user
      ? await resolveSlackUserDisplayName({
          env: input.env,
          connection: input.connection,
          userId: message.user,
          cache: input.userCache,
        })
      : undefined
    const assetLinks: Array<{ label: string; path: string }> = []
    for (const file of message.files ?? []) {
      if (!file.id) continue
      const label = file.name?.trim() || file.id
      assetLinks.push({
        label,
        path: slackFileStubLink(file),
      })
    }
    mirrorMessages.push({
      ts: message.ts,
      userId: message.user,
      userDisplay,
      text: message.text ?? "",
      assetLinks,
    })
  }

  const md = toSlackThreadMarkdownFile({
    channelId: input.channelId,
    channelName: input.channelName,
    isPrivate: input.isPrivate,
    teamId: input.teamId,
    threadTs: input.threadTs,
    messages: mirrorMessages,
  })
  return [{ path: md.path, content: md.content }]
}

export type SlackCaptureResult = {
  status: "completed" | "failed"
  messageCount: number
  commitSha?: string
  /** Repo-relative path to the captured thread markdown (success only). */
  threadPath?: string
  /** GitHub blob URL for the captured markdown (success only, when resolvable). */
  githubUrl?: string
  channelName?: string
  error?: string
}

/**
 * Snapshot-capture a single Slack thread (triggered by `app_mention`) into the
 * org's context repository. No dirty-thread tracking, no channel scope, no
 * config PR — a capture is a point-in-time export (ADR-022 §3-5).
 *
 * `excludeMessageTs` omits the in-thread status reply from the snapshot so the
 * capturing → captured progress message is not ingested as engineering context.
 */
export async function captureSlackThread(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
  channelId: string
  threadTs: string
  excludeMessageTs?: string
}): Promise<SlackCaptureResult> {
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
  try {
    messages = await listSlackConversationReplies({
      env: input.env,
      connection: input.connection,
      channelId: input.channelId,
      threadTs: input.threadTs,
    })
  } catch (error) {
    return {
      status: "failed",
      messageCount: 0,
      channelName,
      error: error instanceof Error ? error.message : "Failed to fetch thread",
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
      error: "Slack thread has no messages to capture",
    }
  }

  const userCache = new Map<string, string>()

  const channelIndex = toSlackChannelIndexFile({
    channelId: input.channelId,
    channelName,
    isPrivate,
    teamId: input.connection.teamId,
  })
  const threadFiles = await buildThreadFiles({
    env: input.env,
    connection: input.connection,
    channelId: input.channelId,
    channelName,
    isPrivate,
    teamId: input.connection.teamId,
    threadTs: input.threadTs,
    messages,
    userCache,
  })
  const threadPath = getSlackThreadPath({
    channelId: input.channelId,
    channelName,
    threadTs: input.threadTs,
  })

  const commit = await commitFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    githubConnectionId,
    message: `chore(slack): capture thread ${input.threadTs} from #${channelName}`,
    files: [channelIndex, ...threadFiles],
    deletePaths: [],
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
  }
}
