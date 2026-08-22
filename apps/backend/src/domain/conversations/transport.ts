import type { UIMessage } from "ai"
import { loadConversationTurns } from "../../models/conversation-messages.js"
import { runTanstackWorkspaceChat } from "../workspaces/tanstack-workspace-chat.js"

export type StreamInput = {
  conversationId: string
  checkpointNamespace: string
  prompt: string
  source?: string | null
  writeStatus?: string | null
  lastBranch?: string | null
  workspaceId?: string | null
  orgId?: string | null
  desiredUrl?: string | null
  desiredSha?: string | null
  desiredGeneration?: number
  defaultBranch?: string
  cloneToken?: string | null
  onHeartbeat?: () => Promise<void> | void
  onFinish?: () => Promise<void> | void
  onError?: () => Promise<void> | void
}

export interface ConversationTransportAdapter {
  toResponse(input: StreamInput): Promise<Response>
}

export function createDataStreamConversationTransport(): ConversationTransportAdapter {
  return new DataStreamConversationTransport()
}

export function workspaceChatStreamReady(input: {
  workspaceId?: string | null
  orgId?: string | null
  desiredUrl?: string | null
}): boolean {
  return Boolean(
    input.workspaceId?.trim() &&
      input.orgId?.trim() &&
      input.desiredUrl?.trim(),
  )
}

class DataStreamConversationTransport implements ConversationTransportAdapter {
  async toResponse(input: StreamInput): Promise<Response> {
    const workspaceId = input.workspaceId?.trim() ?? ""
    const orgId = input.orgId?.trim() ?? ""
    const desiredUrl = input.desiredUrl?.trim() ?? ""
    if (!workspaceChatStreamReady({ workspaceId, orgId, desiredUrl })) {
      return Response.json({ error: "workspace_required" }, { status: 409 })
    }
    return runTanstackWorkspaceChat({
      conversationId: input.conversationId,
      prompt: input.prompt,
      orgId,
      workspaceId,
      desiredUrl,
      desiredSha: input.desiredSha ?? null,
      desiredGeneration: input.desiredGeneration,
      defaultBranch: input.defaultBranch,
      ref: input.lastBranch || input.desiredSha || "HEAD",
      writeStatus: input.writeStatus ?? "read_only",
      cloneToken: input.cloneToken,
      onHeartbeat: input.onHeartbeat,
      onFinish: input.onFinish,
      onError: input.onError,
    })
  }
}

export async function loadConversationUiMessages(input: {
  conversationId: string
  checkpointNamespace: string
  workspaceId?: string | null
}): Promise<UIMessage[]> {
  void input.checkpointNamespace
  if (!input.workspaceId?.trim()) return []
  const turns = await loadConversationTurns(input.conversationId)
  return turns.map((turn, index) => ({
    id: `${input.conversationId}:${index}`,
    role: turn.role,
    parts: [{ type: "text" as const, text: turn.content }],
  }))
}

export function toPromptFromIncomingMessage(message: {
  content?: unknown
  parts?: unknown[]
}): string {
  if (
    typeof message.content === "string" &&
    message.content.trim().length > 0
  ) {
    return message.content
  }
  if (Array.isArray(message.parts)) {
    const textParts = message.parts
      .flatMap((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return [part.text]
        }
        return []
      })
      .join("\n")
      .trim()
    if (textParts.length > 0) return textParts
  }
  return ""
}
