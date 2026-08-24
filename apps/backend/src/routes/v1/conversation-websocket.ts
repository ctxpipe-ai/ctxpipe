import { chatParamsFromRequestBody, type StreamChunk } from "@tanstack/ai"
import { and, eq } from "drizzle-orm"
import { getAuth } from "../../auth/config.js"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { members, organizations } from "../../db/schema/auth.js"
import {
  type ConversationChatRequest,
  parseConversationChatRequest,
  workspaceChatStreamReady,
} from "../../domain/conversations/transport.js"
import { streamTanstackWorkspaceChat } from "../../domain/workspaces/tanstack-workspace-chat.js"
import {
  WORKSPACE_CHAT_HEARTBEAT_MS,
  workspaceChatRunError,
} from "../../domain/workspaces/workspace-chat-agui.js"
import { resolveWorkspaceChatTurnRuntime } from "../../domain/workspaces/workspace-chat-turn-runtime.js"
import { claimWorkspaceChatTurn } from "../../domain/workspaces/workspace-chat-turn-claim.js"
import {
  appendConversationTurn,
  loadConversationTurns,
} from "../../models/conversation-messages.js"
import {
  discardUnstartedConversation,
  ensureConversation,
  touchConversationLastMessage,
} from "../../models/conversations.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import {
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
  WORKSPACE_CHAT_WS_PATH,
} from "./conversation-websocket-url.js"

export {
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
  WORKSPACE_CHAT_WS_PATH,
}

export type ConversationWebSocketData = {
  kind: "workspace-chat"
  orgSlug: string
  orgId: string
  conversationId: string
  userId: string
  ping: ReturnType<typeof setInterval> | null
}

type UpgradeServer = {
  upgrade: (
    request: Request,
    options: { data: ConversationWebSocketData },
  ) => boolean
}

type ChatSocket = {
  data: ConversationWebSocketData
  readyState: number
  send: (data: string) => void
  ping?: () => void
  close: (code?: number, reason?: string) => void
}

export async function handleConversationWebSocket(
  request: Request,
  server: UpgradeServer,
): Promise<Response | undefined> {
  if (!isWorkspaceChatWebSocketRequest(request)) return undefined
  const parsedUrl = parseConversationWebSocketUpgradeUrl(request.url)
  const orgSlug = parsedUrl?.orgSlug
  const conversationId = parsedUrl?.conversationId
  if (!orgSlug || !conversationId) {
    return new Response("Not found", { status: 404 })
  }

  const auth = getAuth()
  const authSession = await auth.api.getSession({
    headers: request.headers,
  })
  if (!authSession?.user || !authSession.session) {
    return new Response("Unauthorized", { status: 401 })
  }

  const orgRows = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, authSession.user.id),
      ),
    )
    .where(eq(organizations.slug, orgSlug))
    .limit(1)
  const org = orgRows[0]
  if (!org) return new Response("Not found", { status: 404 })

  const upgraded = server.upgrade(request, {
    data: {
      kind: "workspace-chat",
      orgSlug,
      orgId: org.id,
      conversationId,
      userId: authSession.user.id,
      ping: null,
    },
  })
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 })
  }
  return undefined
}

export const conversationWebSocketHandlers = {
  open(ws: ChatSocket) {
    ws.data.ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.ping?.()
        ws.send(
          JSON.stringify({
            type: "CUSTOM",
            name: "heartbeat",
            value: { at: Date.now() },
            timestamp: Date.now(),
          }),
        )
      } catch {
        /* socket already closing */
      }
    }, WORKSPACE_CHAT_HEARTBEAT_MS)
  },

  async message(ws: ChatSocket, raw: string | ArrayBuffer | Uint8Array) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      ws.send(JSON.stringify(workspaceChatRunError("Invalid AG-UI frame")))
      return
    }

    await withOrgIdContext({ id: ws.data.orgId, slug: ws.data.orgSlug }, () =>
      withUserIdContext(ws.data.userId, () =>
        runWorkspaceChatSocketTurn(ws, body),
      ),
    )
  },

  close(ws: ChatSocket) {
    if (ws.data.ping) clearInterval(ws.data.ping)
    ws.data.ping = null
  },
}

async function runWorkspaceChatSocketTurn(
  ws: ChatSocket,
  body: unknown,
): Promise<void> {
  const log = getLogger()
  let parsed: ConversationChatRequest
  try {
    parsed = await parseConversationChatRequest(body)
    if (!parsed.prompt) {
      const params = await chatParamsFromRequestBody(body).catch(() => null)
      if (params) {
        parsed = await parseConversationChatRequest(body)
      }
    }
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)), {
      step: "workspace-chat-ws-parse",
    })
    ws.send(JSON.stringify(workspaceChatRunError("Invalid AG-UI frame")))
    return
  }
  if (!parsed.prompt || !parsed.workspaceId.trim()) {
    ws.send(JSON.stringify(workspaceChatRunError("workspace_required")))
    return
  }

  const conversation = await ensureConversation({
    id: ws.data.conversationId,
    source: parsed.source,
    workspaceId: parsed.workspaceId,
  })
  const workspace = conversation.workspaceId
    ? await getWorkspaceById(conversation.workspaceId)
    : null
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const acceptedTurn = claimWorkspaceChatTurn(conversation.id)
  if (!acceptedTurn) {
    ws.send(JSON.stringify(workspaceChatRunError("conversation_busy")))
    return
  }

  try {
    await appendConversationTurn({
      conversationId: conversation.id,
      role: "user",
      content: parsed.prompt,
      orgId: workspace?.orgId ?? conversation.orgId,
    })
    await touchConversationLastMessage(conversation.id)
  } catch (error) {
    acceptedTurn.release()
    log.error(error instanceof Error ? error : new Error(String(error)), {
      step: "workspace-chat-ws-accept",
    })
    await discardUnstartedConversation(conversation.id)
    ws.send(
      JSON.stringify(workspaceChatRunError("Failed to start conversation")),
    )
    return
  }

  if (
    !workspaceChatStreamReady({
      workspaceId: conversation.workspaceId,
      orgId: workspace?.orgId ?? conversation.orgId,
      desiredUrl: workspace?.workspaceRepositoryUrl,
    })
  ) {
    acceptedTurn.release()
    ws.send(JSON.stringify(workspaceChatRunError("workspace_required")))
    return
  }

  try {
    for await (const chunk of streamTanstackWorkspaceChat({
      conversationId: conversation.id,
      prompt: parsed.prompt,
      messages: parsed.messages,
      threadId: parsed.threadId ?? conversation.id,
      runId: parsed.runId,
      orgId: workspace?.orgId ?? conversation.orgId,
      workspaceId: conversation.workspaceId ?? parsed.workspaceId,
      desiredUrl: workspace?.workspaceRepositoryUrl ?? "",
      desiredSha: workspace?.desiredSha ?? null,
      desiredGeneration: workspace?.desiredGeneration,
      ref: conversation.lastBranch || workspace?.desiredSha || "HEAD",
      writeStatus: workspace?.writeStatus ?? "read_only",
      userTurnAccepted: true,
      acceptedTurn,
      resolveRuntime: async () => {
        const runtime = await resolveWorkspaceChatTurnRuntime({
          conversation,
          workspace: workspace
            ? {
                id: workspace.id,
                orgId: workspace.orgId,
                workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                githubConnectionId: workspace.githubConnectionId ?? null,
                writeStatus: workspace.writeStatus,
                desiredSha: workspace.desiredSha ?? null,
                desiredGeneration: workspace.desiredGeneration,
              }
            : null,
          env,
        })
        return {
          ref: runtime.lastBranch || runtime.desiredSha || "HEAD",
          defaultBranch: runtime.defaultBranch,
          cloneToken: runtime.cloneToken,
          writeStatus: runtime.writeStatus,
          desiredUrl: runtime.desiredUrl ?? undefined,
          desiredSha: runtime.desiredSha,
          desiredGeneration: runtime.desiredGeneration,
          orgId: runtime.orgId,
          workspaceId: runtime.workspaceId ?? undefined,
        }
      },
      onError: async () => {
        const turns = await loadConversationTurns(conversation.id)
        if (turns.length === 0) {
          await discardUnstartedConversation(conversation.id)
        }
      },
    })) {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(chunk satisfies StreamChunk | object))
    }
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)), {
      step: "workspace-chat-ws-stream",
    })
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify(workspaceChatRunError("OpenCode chat stream failed")),
      )
    }
  }
}
