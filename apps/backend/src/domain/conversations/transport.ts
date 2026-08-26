import { chatParamsFromRequestBody, modelMessagesToUIMessages } from "@tanstack/ai"
import { loadConversationTurns } from "../../models/conversation-messages.js"
import { workspaceChatPersistence } from "../workspaces/workspace-chat-persistence.js"
import {
  runTanstackWorkspaceChat,
  streamTanstackWorkspaceChat,
  type TanstackWorkspaceChatInput,
} from "../workspaces/tanstack-workspace-chat.js"
import {
  type WorkspaceChatWireFormat,
  withWorkspaceChatHeartbeats,
  workspaceChatHttpResponse,
  workspaceChatWireFormat,
} from "../workspaces/workspace-chat-agui.js"

export type ConversationChatRequest = {
  prompt: string
  workspaceId: string
  source?: string
  messages?: TanstackWorkspaceChatInput["messages"]
  threadId?: string
  runId?: string
}

export type StreamInput = {
  conversationId: string
  checkpointNamespace: string
  prompt: string
  messages?: TanstackWorkspaceChatInput["messages"]
  threadId?: string
  runId?: string
  source?: string | null
  writeStatus?: string | null
  lastBranch?: string | null
  workspaceId?: string | null
  orgId?: string | null
  orgSlug?: string | null
  desiredUrl?: string | null
  desiredSha?: string | null
  desiredGeneration?: number
  defaultBranch?: string
  cloneToken?: string | null
  resolveRuntime?: TanstackWorkspaceChatInput["resolveRuntime"]
  onHeartbeat?: () => Promise<void> | void
  onFinish?: () => Promise<void> | void
  onError?: () => Promise<void> | void
  onUserPersist?: () => Promise<void> | void
  wireFormat?: WorkspaceChatWireFormat
  abortSignal?: AbortSignal
}

export type ConversationChatMessage = {
  id: string
  role: string
  parts: Array<{
    type: string
    content?: string
    text?: string
    name?: string
    id?: string
  }>
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

function toChatInput(input: StreamInput): TanstackWorkspaceChatInput | null {
  const workspaceId = input.workspaceId?.trim() ?? ""
  const orgId = input.orgId?.trim() ?? ""
  const desiredUrl = input.desiredUrl?.trim() ?? ""
  if (!workspaceId) return null
  if (
    !input.resolveRuntime &&
    !workspaceChatStreamReady({ workspaceId, orgId, desiredUrl })
  ) {
    return null
  }
  return {
    conversationId: input.conversationId,
    prompt: input.prompt,
    messages: input.messages,
    threadId: input.threadId,
    runId: input.runId,
    orgId,
    orgSlug: input.orgSlug?.trim() || undefined,
    workspaceId,
    desiredUrl,
    desiredSha: input.desiredSha ?? null,
    desiredGeneration: input.desiredGeneration,
    defaultBranch: input.defaultBranch,
    ref: input.lastBranch || input.desiredSha || "HEAD",
    writeStatus: input.writeStatus ?? "read_only",
    cloneToken: input.cloneToken,
    abortSignal: input.abortSignal,
    resolveRuntime: input.resolveRuntime,
    onHeartbeat: input.onHeartbeat,
    onFinish: input.onFinish,
    onError: input.onError,
    onUserPersist: input.onUserPersist,
    wireFormat: input.wireFormat,
  }
}

class DataStreamConversationTransport implements ConversationTransportAdapter {
  async toResponse(input: StreamInput): Promise<Response> {
    const chatInput = toChatInput(input)
    if (!chatInput) {
      return Response.json({ error: "workspace_required" }, { status: 409 })
    }
    return runTanstackWorkspaceChat(chatInput)
  }
}

export function workspaceChatStreamResponse(
  input: StreamInput,
  request?: Request,
): Response {
  const chatInput = toChatInput(input)
  if (!chatInput) {
    return Response.json({ error: "workspace_required" }, { status: 409 })
  }
  const format =
    input.wireFormat ?? (request ? workspaceChatWireFormat(request) : "sse")
  return workspaceChatHttpResponse(
    withWorkspaceChatHeartbeats(streamTanstackWorkspaceChat(chatInput)),
    format,
    request,
  )
}

export async function loadConversationUiMessages(input: {
  conversationId: string
  checkpointNamespace: string
  workspaceId?: string | null
}): Promise<ConversationChatMessage[]> {
  void input.checkpointNamespace
  if (!input.workspaceId?.trim()) return []
  const stored = await workspaceChatPersistence()
    .stores.messages.loadThread(input.conversationId)
    .catch(() => [])
  if (stored.length > 0) {
    return modelMessagesToUIMessages(stored) as ConversationChatMessage[]
  }
  const turns = await loadConversationTurns(input.conversationId)
  return turns.map((turn, index) => ({
    id: `${input.conversationId}:${index}`,
    role: turn.role,
    parts: [{ type: "text" as const, content: turn.content }],
  }))
}

export function textFromMessagePart(part: unknown): string {
  if (!part || typeof part !== "object") return ""
  const record = part as { type?: unknown; content?: unknown; text?: unknown }
  if (record.type !== "text") return ""
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content
  }
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text
  }
  return ""
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
  if (Array.isArray(message.content)) {
    const fromContentParts = message.content
      .map(textFromMessagePart)
      .filter(Boolean)
      .join("\n")
      .trim()
    if (fromContentParts.length > 0) return fromContentParts
  }
  if (Array.isArray(message.parts)) {
    const textParts = message.parts
      .map(textFromMessagePart)
      .filter(Boolean)
      .join("\n")
      .trim()
    if (textParts.length > 0) return textParts
  }
  return ""
}

export async function parseConversationChatRequest(
  body: unknown,
): Promise<ConversationChatRequest> {
  if (body && typeof body === "object" && "messages" in body) {
    const params = await chatParamsFromRequestBody(body)
    const last = [...params.messages].reverse().find((message) => {
      return "role" in message && message.role === "user"
    })
    const prompt = last
      ? toPromptFromIncomingMessage(
          last as { content?: unknown; parts?: unknown[] },
        )
      : ""
    const forwarded = params.forwardedProps
    const workspaceId =
      (typeof forwarded.workspaceId === "string" && forwarded.workspaceId) ||
      (typeof forwarded.workspace_id === "string" && forwarded.workspace_id) ||
      ""
    const source =
      typeof forwarded.source === "string" ? forwarded.source : undefined
    return {
      prompt,
      workspaceId,
      source,
      messages: params.messages,
      threadId: params.threadId,
      runId: params.runId,
    }
  }

  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const message =
    record.message && typeof record.message === "object"
      ? (record.message as { content?: unknown; parts?: unknown[] })
      : {}
  const workspaceId =
    typeof record.workspaceId === "string" ? record.workspaceId : ""
  const source = typeof record.source === "string" ? record.source : undefined
  return {
    prompt: toPromptFromIncomingMessage(message),
    workspaceId,
    source,
  }
}
