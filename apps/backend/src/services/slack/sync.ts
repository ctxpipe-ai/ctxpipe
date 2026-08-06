import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  SlackConnection,
  SlackSyncTarget,
} from "../../models/slack-connector.js"
import {
  clearSlackDirtyThreads,
  listReadySlackDirtyThreads,
  listSlackChannelsByConnectionId,
} from "../../models/slack-connector.js"
import {
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  isSlackDirtyThreadReady,
  msUntilSlackDirtyThreadReady,
} from "./cadence.js"
import {
  type SlackApiMessage,
  downloadSlackFile,
  listSlackConversationHistory,
  listSlackConversationReplies,
  resolveSlackUserDisplayName,
  SLACK_FILE_MAX_BYTES,
} from "./client.js"
import { loadSlackScopeFromRepo, SLACK_CONFIG_PATH } from "./config-from-repo.js"
import type { ParsedSlackRepoConfig } from "./config-yaml.js"
import {
  getSlackConfigPullRequestPayload,
  hasSlackConfigYamlChanged,
  renderSlackConfigYaml,
} from "./config-yaml.js"
import {
  getManagedSlackRootPath,
  getSlackThreadAssetPath,
  getSlackThreadDirPath,
  toSlackChannelIndexFile,
  toSlackThreadMarkdownFile,
  type SlackMirrorMessage,
} from "./converter.js"

function managedPathsUnderThreadDir(
  managedRepoPaths: string[],
  threadDir: string,
): string[] {
  const prefix = `${threadDir}/`
  return managedRepoPaths.filter(
    (path) => path === `${threadDir}/index.md` || path.startsWith(prefix),
  )
}

export type SlackSyncResult = {
  status: "completed" | "partial_failed" | "failed"
  threadsProcessed: number
  threadsFailed: number
  commitSha?: string
  pullUrl?: string
  /** Present when dirty rows exist but quiet/max-lag has not elapsed yet. */
  rescheduleAfterMs?: number
  errors: Array<{ channelId: string; threadTs?: string; message: string }>
}

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

export function getSlackDeletePaths(input: {
  managedRepoPaths: string[]
  desiredPaths: Set<string>
  threadsFailed: number
}): string[] {
  if (input.threadsFailed > 0) return []
  return input.managedRepoPaths.filter((path) => !input.desiredPaths.has(path))
}

function isVideoOrOversized(file: {
  mimetype?: string
  size?: number
}): boolean {
  if (file.mimetype?.startsWith("video/")) return true
  if (typeof file.size === "number" && file.size > SLACK_FILE_MAX_BYTES) {
    return true
  }
  return false
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
}): Promise<Array<{ path: string; content: string; encoding?: "utf-8" | "base64" }>> {
  const mirrorMessages: SlackMirrorMessage[] = []
  const assetFiles: Array<{
    path: string
    content: string
    encoding?: "utf-8" | "base64"
  }> = []

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
      const label = file.name ?? file.id
      if (
        isVideoOrOversized(file) ||
        !file.url_private_download
      ) {
        assetLinks.push({
          label: `${label} (not archived)`,
          path: input.teamId
            ? `https://slack.com/files`
            : `#file-${file.id}`,
        })
        continue
      }
      const downloaded = await downloadSlackFile({
        env: input.env,
        connection: input.connection,
        urlPrivateDownload: file.url_private_download,
      })
      if (!downloaded) {
        assetLinks.push({
          label: `${label} (download failed)`,
          path: `#file-${file.id}`,
        })
        continue
      }
      const assetPath = getSlackThreadAssetPath({
        channelId: input.channelId,
        channelName: input.channelName,
        threadTs: input.threadTs,
        fileId: file.id,
        fileName: file.name ?? file.id,
      })
      assetFiles.push({
        path: assetPath,
        content: Buffer.from(downloaded.bytes).toString("base64"),
        encoding: "base64",
      })
      const relative = `./assets/${assetPath.split("/assets/")[1] ?? ""}`
      assetLinks.push({ label, path: relative })
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
  return [{ path: md.path, content: md.content }, ...assetFiles]
}

export async function syncSlackConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
}): Promise<{ changed: boolean; pullUrl?: string }> {
  const channels = await withOrgDbContext(input.orgId, () =>
    listSlackChannelsByConnectionId(input.connection.id),
  )
  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)

  const priorNum = input.target.pendingConfigPullUrl
    ? parseGithubPullNumberFromUrl(input.target.pendingConfigPullUrl)
    : undefined
  if (priorNum !== undefined) {
    await closePullRequest({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      pullNumber: priorNum,
      comment:
        "Closing in favor of an updated Slack sync configuration proposal.",
    })
  }

  const next = renderSlackConfigYaml({
    teamId: input.connection.teamId,
    oldestDays: input.target.oldestDays,
    channels: channels.map((channel) => ({
      channelId: channel.channelId,
      name: channel.name,
      isPrivate: channel.isPrivate,
    })),
  })
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    branch: input.target.branch,
    path: SLACK_CONFIG_PATH,
  })
  if (!hasSlackConfigYamlChanged({ current, next })) {
    return { changed: false }
  }
  const pr = getSlackConfigPullRequestPayload({ orgSlug: input.orgSlug })
  const created = await createPullRequestWithFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    baseBranch: input.target.branch,
    title: pr.title,
    body: pr.body,
    commitMessage: pr.commitMessage,
    featureBranchPrefix: "ctxpipe/slack-config",
    files: [{ path: SLACK_CONFIG_PATH, content: next }],
  })
  return { pullUrl: created.pullUrl, changed: true }
}

export async function syncSlackContent(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
  scopeFromRepo?: ParsedSlackRepoConfig
}): Promise<SlackSyncResult> {
  if (!input.target.enabled) {
    return {
      status: "completed",
      threadsProcessed: 0,
      threadsFailed: 0,
      errors: [],
    }
  }
  if (input.target.setupPhase === "awaiting_merge") {
    return {
      status: "completed",
      threadsProcessed: 0,
      threadsFailed: 0,
      errors: [],
    }
  }

  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)

  let scope = input.scopeFromRepo
  if (!scope) {
    scope = await loadSlackScopeFromRepo({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      branch: input.target.branch,
    })
  }
  if (!scope) {
    return {
      status: "failed",
      threadsProcessed: 0,
      threadsFailed: 0,
      errors: [{ channelId: "*", message: "Missing slack/config.yaml in repo" }],
    }
  }

  const oldest =
    Math.floor(Date.now() / 1000) - scope.oldestDays * 24 * 60 * 60
  const oldestStr = String(oldest)
  const userCache = new Map<string, string>()
  const filesToWrite: Array<{
    path: string
    content: string
    encoding?: "utf-8" | "base64"
  }> = []
  const errors: SlackSyncResult["errors"] = []
  let threadsProcessed = 0
  let threadsFailed = 0

  for (const channel of scope.channels) {
    filesToWrite.push(
      toSlackChannelIndexFile({
        channelId: channel.channelId,
        channelName: channel.name,
        isPrivate: channel.isPrivate,
        teamId: input.connection.teamId,
      }),
    )

    let cursor: string | undefined
    try {
      do {
        const page = await listSlackConversationHistory({
          env: input.env,
          connection: input.connection,
          channelId: channel.channelId,
          oldest: oldestStr,
          cursor,
        })
        for (const message of page.messages) {
          if (message.subtype && message.subtype !== "thread_broadcast") {
            continue
          }
          const threadTs = message.thread_ts ?? message.ts
          if (!threadTs) continue
          // Only expand threads once (parent or unthreaded message).
          if (message.thread_ts && message.thread_ts !== message.ts) continue
          try {
            const replies =
              (message.reply_count ?? 0) > 0 || message.thread_ts
                ? await listSlackConversationReplies({
                    env: input.env,
                    connection: input.connection,
                    channelId: channel.channelId,
                    threadTs,
                  })
                : [message]
            const threadFiles = await buildThreadFiles({
              env: input.env,
              connection: input.connection,
              channelId: channel.channelId,
              channelName: channel.name,
              isPrivate: channel.isPrivate,
              teamId: input.connection.teamId,
              threadTs,
              messages: replies,
              userCache,
            })
            filesToWrite.push(...threadFiles)
            threadsProcessed += 1
          } catch (error) {
            threadsFailed += 1
            errors.push({
              channelId: channel.channelId,
              threadTs,
              message:
                error instanceof Error ? error.message : "Thread sync failed",
            })
          }
        }
        cursor = page.nextCursor
      } while (cursor)
    } catch (error) {
      threadsFailed += 1
      errors.push({
        channelId: channel.channelId,
        message:
          error instanceof Error ? error.message : "Channel history failed",
      })
    }
  }

  const managedRoot = getManagedSlackRootPath()
  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    githubConnectionId,
  })
  const managedRepoFiles = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) => path.startsWith(managedRoot) && path !== SLACK_CONFIG_PATH,
    )
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const deletePaths = getSlackDeletePaths({
    managedRepoPaths: managedRepoFiles,
    desiredPaths,
    threadsFailed,
  })

  const filesToCommit: typeof filesToWrite = []
  for (const file of filesToWrite) {
    if (file.encoding === "base64") {
      filesToCommit.push(file)
      continue
    }
    const current = await getFileContent({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
      path: file.path,
      githubConnectionId,
    })
    if (current === file.content) continue
    filesToCommit.push(file)
  }

  let commitSha: string | undefined
  if (filesToCommit.length > 0 || deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
      githubConnectionId,
      message: "chore(slack): sync content",
      files: filesToCommit,
      deletePaths,
    })
    commitSha = commit.commitSha
  }

  const status: SlackSyncResult["status"] =
    threadsFailed === 0
      ? "completed"
      : threadsProcessed > 0
        ? "partial_failed"
        : "failed"
  return {
    status,
    threadsProcessed,
    threadsFailed,
    commitSha,
    errors,
  }
}

export async function flushSlackDirtyThreads(input: {
  orgId: string
  env: Env
  connection: SlackConnection
  target: SlackSyncTarget
}): Promise<SlackSyncResult> {
  if (!input.target.enabled || input.target.setupPhase !== "live") {
    return {
      status: "completed",
      threadsProcessed: 0,
      threadsFailed: 0,
      errors: [],
    }
  }

  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)
  const scope = await loadSlackScopeFromRepo({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    branch: input.target.branch,
  })
  if (!scope) {
    return {
      status: "failed",
      threadsProcessed: 0,
      threadsFailed: 0,
      errors: [{ channelId: "*", message: "Missing slack/config.yaml in repo" }],
    }
  }

  const channelById = new Map(
    scope.channels.map((channel) => [channel.channelId, channel]),
  )
  const dirty = await listReadySlackDirtyThreads(input.connection.id)
  const ready = dirty.filter((row) =>
    isSlackDirtyThreadReady({
      lastEventAt: row.lastEventAt,
      firstDirtyAt: row.firstDirtyAt,
    }),
  )
  if (ready.length === 0) {
    const waitMs =
      dirty.length === 0
        ? undefined
        : Math.min(
            ...dirty.map((row) =>
              msUntilSlackDirtyThreadReady({
                lastEventAt: row.lastEventAt,
                firstDirtyAt: row.firstDirtyAt,
              }),
            ),
          )
    return {
      status: "completed",
      threadsProcessed: 0,
      threadsFailed: 0,
      rescheduleAfterMs: waitMs && waitMs > 0 ? waitMs : undefined,
      errors: [],
    }
  }

  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    githubConnectionId,
  })
  const managedRepoPaths = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path.startsWith(getManagedSlackRootPath()) &&
        path !== SLACK_CONFIG_PATH,
    )

  const userCache = new Map<string, string>()
  const filesToWrite: Array<{
    path: string
    content: string
    encoding?: "utf-8" | "base64"
  }> = []
  const deletePaths: string[] = []
  const errors: SlackSyncResult["errors"] = []
  const cleared: Array<{ id: string; revision: number }> = []
  let threadsProcessed = 0
  let threadsFailed = 0

  for (const row of ready) {
    const channel = channelById.get(row.channelId)
    if (!channel) {
      cleared.push({ id: row.id, revision: row.revision })
      continue
    }
    try {
      const replies = await listSlackConversationReplies({
        env: input.env,
        connection: input.connection,
        channelId: row.channelId,
        threadTs: row.threadTs,
      })
      if (replies.length === 0) {
        const threadDir = getSlackThreadDirPath({
          channelId: channel.channelId,
          channelName: channel.name,
          threadTs: row.threadTs,
        })
        deletePaths.push(
          ...managedPathsUnderThreadDir(managedRepoPaths, threadDir),
        )
        threadsProcessed += 1
        cleared.push({ id: row.id, revision: row.revision })
        continue
      }
      const threadFiles = await buildThreadFiles({
        env: input.env,
        connection: input.connection,
        channelId: channel.channelId,
        channelName: channel.name,
        isPrivate: channel.isPrivate,
        teamId: input.connection.teamId,
        threadTs: row.threadTs,
        messages: replies,
        userCache,
      })
      filesToWrite.push(...threadFiles)
      threadsProcessed += 1
      cleared.push({ id: row.id, revision: row.revision })
    } catch (error) {
      threadsFailed += 1
      errors.push({
        channelId: row.channelId,
        threadTs: row.threadTs,
        message:
          error instanceof Error ? error.message : "Thread flush failed",
      })
    }
  }

  const uniqueDeletePaths =
    threadsFailed > 0 ? [] : [...new Set(deletePaths)]

  let commitSha: string | undefined
  if (filesToWrite.length > 0 || uniqueDeletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
      githubConnectionId,
      message: "chore(slack): sync dirty threads",
      files: filesToWrite,
      deletePaths: uniqueDeletePaths,
    })
    commitSha = commit.commitSha
  }

  if (cleared.length > 0) {
    await clearSlackDirtyThreads({
      connectionId: input.connection.id,
      keys: cleared,
    })
  }

  const status: SlackSyncResult["status"] =
    threadsFailed === 0
      ? "completed"
      : threadsProcessed > 0
        ? "partial_failed"
        : "failed"
  return { status, threadsProcessed, threadsFailed, commitSha, errors }
}
