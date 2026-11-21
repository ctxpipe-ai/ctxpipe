import {
  ensureConversation,
  getConversation,
  setUnstartedConversationBase,
  touchConversationLastMessage,
} from "../../models/conversations.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { parseBaseBranch } from "./conversation-base.js"
import type { TanstackWorkspaceChatInput } from "./tanstack-workspace-chat.js"
import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"
import { withDestroyedConversationSandboxes } from "./workspace-sandbox-cleanup.js"

export async function resolveWorkspaceChatSendRuntime(input: {
  conversationId: string
  workspaceId: string
  source?: string
  baseBranch?: string
}): Promise<Partial<TanstackWorkspaceChatInput>> {
  const baseBranch = parseBaseBranch(input.baseBranch)
  const ensured = await ensureConversation({
    id: input.conversationId,
    source: input.source,
    workspaceId: input.workspaceId,
    baseBranch,
  })
  // The first message names another base branch than a prepare that came
  // before it: the sandbox of the old base branch goes (ADR-071).
  const baseChanged =
    baseBranch !== undefined &&
    (await setUnstartedConversationBase({
      conversationId: input.conversationId,
      baseBranch,
    }))
  if (baseChanged && ensured.workspaceId)
    await withDestroyedConversationSandboxes(
      {
        conversationId: input.conversationId,
        orgId: ensured.orgId,
        workspaceId: ensured.workspaceId,
      },
      async () => {},
    )
  const conversation =
    (baseChanged && (await getConversation(input.conversationId))) || ensured
  const workspace = conversation.workspaceId
    ? await getWorkspaceById(conversation.workspaceId)
    : null
  const runtime = await resolveWorkspaceChatTurnRuntime({
    conversation,
    workspace: workspace
      ? {
          id: workspace.id,
          orgId: workspace.orgId,
          workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
          githubConnectionId: workspace.githubConnectionId ?? null,
          writeStatus: workspace.writeStatus,
          desiredSha: workspace.desiredSha,
          desiredDefaultBranch: workspace.desiredDefaultBranch,
          readOnlyReason: workspace.readOnlyReason,
          desiredGeneration: workspace.desiredGeneration,
        }
      : null,
  })
  return {
    orgId: runtime.orgId,
    workspaceId: runtime.workspaceId ?? input.workspaceId,
    desiredUrl: runtime.desiredUrl ?? "",
    desiredSha: runtime.desiredSha,
    desiredGeneration: runtime.desiredGeneration,
    writeStatus: runtime.writeStatus,
    defaultBranch: runtime.defaultBranch,
    baseBranch: runtime.baseBranch,
    lastBranch: runtime.lastBranch,
    ref: runtime.cloneRef || runtime.desiredSha || "HEAD",
    githubConnectionId: runtime.githubConnectionId,
    rootPath: workspace?.rootPath ?? "",
  }
}

export async function persistWorkspaceChatUserTurnListed(
  conversationId: string,
): Promise<void> {
  await touchConversationLastMessage(conversationId)
}
