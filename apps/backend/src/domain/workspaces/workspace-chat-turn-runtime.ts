import { parseEnv } from "../../config/env.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import { baseBranchTip } from "./conversation-base.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

type WorkspaceChatTurnConversation = {
  id: string
  orgId: string
  workspaceId: string | null
  lastBranch: string | null
  baseBranch: string | null
}

type WorkspaceChatTurnWorkspace = {
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
  /** The base branch when it is not the default branch (ADR-071). */
  baseBranch: string | null
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
  const baseBranch =
    conversation.baseBranch && conversation.baseBranch !== defaultBranch
      ? conversation.baseBranch
      : null
  // On another base branch, the conversation builds on the tip of that
  // branch. Without that branch on the remote, the SHA is null, and the
  // sandbox build refuses the conversation.
  const desiredSha =
    baseBranch && workspace
      ? await baseBranchTip({
          orgId: workspace.orgId,
          env: parseEnv(process.env as Record<string, string | undefined>),
          remote: {
            url: workspace.workspaceRepositoryUrl,
            connectionId: workspace.githubConnectionId ?? null,
          },
          branch: baseBranch,
        })
      : (workspace?.desiredSha ?? null)
  const lastBranch =
    conversation.lastBranch?.trim() || baseBranch || defaultBranch
  return {
    lastBranch,
    cloneRef: desiredSha || baseBranch || defaultBranch,
    defaultBranch,
    baseBranch,
    githubConnectionId: workspace?.githubConnectionId ?? null,
    // This runtime permission applies to the conversation session branch.
    writeStatus: canEdit ? "writable" : (workspace?.writeStatus ?? "read_only"),
    desiredUrl: workspace?.workspaceRepositoryUrl ?? null,
    desiredSha,
    desiredGeneration: workspace?.desiredGeneration,
    orgId: workspace?.orgId ?? conversation.orgId,
    workspaceId: conversation.workspaceId,
  }
}
