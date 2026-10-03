import type { Env } from "../../config/env.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import { log } from "../../observability/logger.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
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
  readOnlyReason?: string | null
  desiredSha: string | null
  desiredDefaultBranch?: string | null
  desiredGeneration?: number
}

export async function resolveWorkspaceChatTurnRuntime(input: {
  conversation: WorkspaceChatTurnConversation
  workspace: WorkspaceChatTurnWorkspace | null
  env: Env
}): Promise<{
  lastBranch: string
  cloneRef: string
  defaultBranch: string
  cloneToken: string | null
  githubConnectionId: string | null
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
  const defaultBranch = workspace?.desiredDefaultBranch?.trim() || "main"
  if (repoName && !workspace?.desiredDefaultBranch?.trim()) {
    throw new Error("Workspace chat needs a captured default branch")
  }
  const cloneToken =
    workspace && repoName
      ? ((await getRepoReadCloneToken(workspace.orgId, env, {
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          repoFullName: repoName,
        })) ?? null)
      : null
  log.info({
    step: "workspace-chat-timing",
    phase: "github-resolve",
    message: `workspace chat timing github-resolve ${Date.now() - githubStarted}ms`,
    ms: Date.now() - githubStarted,
    conversationId: conversation.id,
  })
  const canEdit = workspaceAllowsConversationEdits(
    workspace?.writeStatus ?? "read_only",
    workspace?.readOnlyReason,
  )
  const lastBranch = conversation.lastBranch?.trim() || defaultBranch
  const cloneRef = workspace?.desiredSha ?? defaultBranch
  return {
    lastBranch,
    cloneRef: cloneRef || workspace?.desiredSha || defaultBranch,
    defaultBranch,
    cloneToken,
    githubConnectionId: workspace?.githubConnectionId ?? null,
    // This runtime permission applies to the conversation session branch.
    writeStatus: canEdit ? "writable" : (workspace?.writeStatus ?? "read_only"),
    desiredUrl: workspace?.workspaceRepositoryUrl ?? null,
    desiredSha: workspace?.desiredSha ?? null,
    desiredGeneration: workspace?.desiredGeneration,
    orgId: workspace?.orgId ?? conversation.orgId,
    workspaceId: conversation.workspaceId,
  }
}
