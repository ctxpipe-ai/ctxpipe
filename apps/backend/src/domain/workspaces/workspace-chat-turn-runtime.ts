import {
  applyQuietChatUpdate,
  lastBranchExistsOnRemote,
  quietUpdateChatBranch,
  restoreBranchAfterIdle,
  treeDirtyFromPorcelain,
} from "./chat-lifecycle.js"
import { getChatSandbox } from "./sandbox-registry.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"
import { persistConversationLastBranch } from "../../models/conversations.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import { log } from "../../observability/logger.js"
import { githubRefExists } from "../../services/github/installation-write-client.js"
import { resolveGithubDefaultBranch } from "../../routes/webhooks/github/github-workspace-tip.js"
import type { Env } from "../../config/env.js"

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
  const chatSandbox = getChatSandbox(conversation.id)
  if (chatSandbox && workspace?.desiredSha) {
    const status = await chatSandbox.exec("git status --porcelain", {
      env: {},
    })
    const tipPresent = await chatSandbox.exec(
      `git cat-file -t ${workspace.desiredSha}`,
      { env: {} },
    )
    const treeDirty = treeDirtyFromPorcelain(status.stdout)
    await applyQuietChatUpdate({
      decision: quietUpdateChatBranch({
        lastBranch,
        defaultBranch,
        lastBranchPublished:
          remoteHasLastBranch && lastBranch.startsWith("ctxpipe/chat/"),
        treeDirty,
        rebaseApplies: tipPresent.exitCode === 0 && treeDirty,
      }),
      desiredSha: workspace.desiredSha,
      exec: chatSandbox.exec,
    }).catch(() => undefined)
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
