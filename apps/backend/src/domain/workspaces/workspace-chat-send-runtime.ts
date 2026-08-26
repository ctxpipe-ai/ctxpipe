import { parseEnv } from "../../config/env.js"
import {
  ensureConversation,
  touchConversationLastMessage,
} from "../../models/conversations.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import type { TanstackWorkspaceChatInput } from "./tanstack-workspace-chat.js"
import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"

export async function resolveWorkspaceChatSendRuntime(input: {
  conversationId: string
  workspaceId: string
  source?: string
}): Promise<Partial<TanstackWorkspaceChatInput>> {
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
  return {
    orgId: runtime.orgId,
    workspaceId: runtime.workspaceId ?? input.workspaceId,
    desiredUrl: runtime.desiredUrl ?? "",
    desiredSha: runtime.desiredSha,
    desiredGeneration: runtime.desiredGeneration,
    writeStatus: runtime.writeStatus,
    defaultBranch: runtime.defaultBranch,
    ref: runtime.cloneRef || runtime.desiredSha || "HEAD",
    cloneToken: runtime.cloneToken ?? null,
  }
}

export async function persistWorkspaceChatUserTurnListed(
  conversationId: string,
): Promise<void> {
  await touchConversationLastMessage(conversationId)
}
