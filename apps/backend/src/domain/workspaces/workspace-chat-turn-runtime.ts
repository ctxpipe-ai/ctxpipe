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
}): Promise<{
  lastBranch: string
  cloneRef: string
  defaultBranch: string
  githubConnectionId: string | null
  writeStatus: string
  desiredUrl: string | null
  desiredSha: string | null
  desiredGeneration?: number
  orgId: string
  workspaceId: string | null
}> {
  const { conversation, workspace } = input
  const repoName = workspace
    ? githubRepoFullNameFromWorkspaceUrl(workspace.workspaceRepositoryUrl)
    : null
  const defaultBranch = workspace?.desiredDefaultBranch?.trim() || "main"
  if (repoName && !workspace?.desiredDefaultBranch?.trim()) {
    throw new Error("Workspace chat needs a captured default branch")
  }
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
