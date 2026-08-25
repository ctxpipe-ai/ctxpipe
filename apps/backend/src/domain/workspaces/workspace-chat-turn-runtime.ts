import type { Env } from "../../config/env.js"
import { persistConversationLastBranch } from "../../models/conversations.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import { log } from "../../observability/logger.js"
import { resolveGithubDefaultBranch } from "../../routes/webhooks/github/github-workspace-tip.js"
import { githubRefExists } from "../../services/github/installation-write-client.js"
import {
  lastBranchExistsOnRemote,
  restoreBranchAfterIdle,
} from "./chat-lifecycle.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export type WorkspaceChatTurnConversation = {
  id: string
  orgId: string
  workspaceId: string | null
  lastBranch: string | null
}

export type WorkspaceChatTurnWorkspace = {
  id: string
  orgId: string
  workspaceRepositoryUrl: string
  githubConnectionId?: string | null
  writeStatus: string
  desiredSha: string | null
  desiredGeneration?: number
}

export async function resolveWorkspaceChatTurnRuntime(input: {
  conversation: WorkspaceChatTurnConversation
  workspace: WorkspaceChatTurnWorkspace | null
  env: Env
}): Promise<{
  lastBranch: string
  defaultBranch: string
  cloneToken: string | null
  writeStatus: string
  desiredUrl: string | null
  desiredSha: string | null
  desiredGeneration?: number
  orgId: string
  workspaceId: string | null
}> {
  const { conversation, workspace, env } = input
  const repoName = workspace
    ? githubRepoFullNameFromWorkspaceUrl(workspace.workspaceRepositoryUrl)
    : null
  const githubStarted = Date.now()
  const [defaultBranch, cloneToken, remoteHasLastBranch] = await Promise.all([
    workspace && repoName
      ? resolveGithubDefaultBranch({
          orgId: workspace.orgId,
          githubConnectionId: workspace.githubConnectionId,
          repoFullName: repoName,
          env,
        }).then((branch) => branch ?? "main")
      : Promise.resolve("main"),
    workspace && repoName
      ? getRepoReadCloneToken(workspace.orgId, env, {
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          repoFullName: repoName,
        }).then((token) => token ?? null)
      : Promise.resolve(null),
    conversation.lastBranch && workspace && repoName
      ? githubRefExists({
          orgId: workspace.orgId,
          repositoryName: repoName,
          env,
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          ref: conversation.lastBranch,
        }).catch(() => false)
      : Promise.resolve(false),
  ])
  log.info({
    step: "workspace-chat-timing",
    phase: "github-resolve",
    message: `workspace chat timing github-resolve ${Date.now() - githubStarted}ms`,
    ms: Date.now() - githubStarted,
    conversationId: conversation.id,
  })
  const lastBranch = restoreBranchAfterIdle({
    lastBranch: conversation.lastBranch,
    lastBranchExistsOnRemote: lastBranchExistsOnRemote({
      lastBranch: conversation.lastBranch,
      remoteBranches:
        remoteHasLastBranch && conversation.lastBranch
          ? [conversation.lastBranch]
          : [],
    }),
    defaultBranch,
  })
  if (lastBranch.startsWith("ctxpipe/chat/")) {
    await persistConversationLastBranch({
      conversationId: conversation.id,
      lastBranch,
    })
  }
  return {
    lastBranch,
    defaultBranch,
    cloneToken,
    writeStatus: workspace?.writeStatus ?? "read_only",
    desiredUrl: workspace?.workspaceRepositoryUrl ?? null,
    desiredSha: workspace?.desiredSha ?? null,
    desiredGeneration: workspace?.desiredGeneration,
    orgId: workspace?.orgId ?? conversation.orgId,
    workspaceId: conversation.workspaceId,
  }
}
