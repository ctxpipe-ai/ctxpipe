import { parseEnv } from "../../config/env.js"
import {
  ensureConversation,
  touchConversationLastMessage,
} from "../../models/conversations.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import type { TanstackWorkspaceChatInput } from "./tanstack-workspace-chat.js"
import {
  getWorkspaceChatConversationRuntime,
  setWorkspaceChatConversationRuntime,
  type WorkspaceChatConversationWorkspace,
} from "./workspace-chat-conversation-runtime.js"
import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"

export function workspaceSnapshotFromChatInput(
  input: Pick<
    TanstackWorkspaceChatInput,
    | "orgId"
    | "workspaceId"
    | "desiredUrl"
    | "desiredSha"
    | "desiredGeneration"
    | "writeStatus"
    | "defaultBranch"
    | "ref"
    | "cloneToken"
  >,
): WorkspaceChatConversationWorkspace {
  return {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    desiredUrl: input.desiredUrl,
    desiredSha: input.desiredSha,
    desiredGeneration: input.desiredGeneration,
    writeStatus: input.writeStatus,
    defaultBranch: input.defaultBranch,
    lastBranch: input.ref,
    cloneToken: input.cloneToken ?? null,
  }
}

export function chatInputFromWorkspaceSnapshot(
  workspace: WorkspaceChatConversationWorkspace,
): Partial<TanstackWorkspaceChatInput> {
  return {
    orgId: workspace.orgId,
    workspaceId: workspace.workspaceId,
    desiredUrl: workspace.desiredUrl,
    desiredSha: workspace.desiredSha,
    desiredGeneration: workspace.desiredGeneration,
    writeStatus: workspace.writeStatus,
    defaultBranch: workspace.defaultBranch,
    ref: workspace.lastBranch || workspace.desiredSha || "HEAD",
    cloneToken: workspace.cloneToken ?? null,
  }
}

export async function resolveWorkspaceChatSendRuntime(input: {
  conversationId: string
  workspaceId: string
  source?: string
}): Promise<Partial<TanstackWorkspaceChatInput>> {
  const warm = getWorkspaceChatConversationRuntime(input.conversationId)
  if (warm?.workspace?.desiredUrl.trim()) {
    return chatInputFromWorkspaceSnapshot(warm.workspace)
  }

  const conversation = await ensureConversation({
    id: input.conversationId,
    source: input.source,
    workspaceId: input.workspaceId,
  })
  const workspace = conversation.workspaceId
    ? await getWorkspaceById(conversation.workspaceId)
    : null
  const env = parseEnv(process.env as Record<string, string | undefined>)
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
          desiredGeneration: workspace.desiredGeneration,
        }
      : null,
    env,
  })
  const snapshot: WorkspaceChatConversationWorkspace = {
    orgId: runtime.orgId,
    workspaceId: runtime.workspaceId ?? input.workspaceId,
    desiredUrl: runtime.desiredUrl ?? "",
    desiredSha: runtime.desiredSha,
    desiredGeneration: runtime.desiredGeneration,
    writeStatus: runtime.writeStatus,
    defaultBranch: runtime.defaultBranch,
    lastBranch: runtime.lastBranch,
    cloneToken: runtime.cloneToken,
  }
  if (warm) {
    setWorkspaceChatConversationRuntime({
      ...warm,
      workspace: snapshot,
    })
  }
  return chatInputFromWorkspaceSnapshot(snapshot)
}

export async function persistWorkspaceChatUserTurnListed(
  conversationId: string,
): Promise<void> {
  await touchConversationLastMessage(conversationId)
}
