import {
  memoryStream,
  toWebSocketStream,
  type WebSocketLike,
} from "@tanstack/ai"
import { and, eq } from "drizzle-orm"
import { getAuth } from "../../auth/config.js"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb } from "../../db/client.js"
import { members, organizations } from "../../db/schema/auth.js"
import {
  type ConversationChatRequest,
  parseConversationChatRequest,
} from "../../domain/conversations/transport.js"
import {
  conversationHasStoredTurns,
  streamTanstackWorkspaceChat,
} from "../../domain/workspaces/tanstack-workspace-chat.js"
import { workspaceChatRunError } from "../../domain/workspaces/workspace-chat-agui.js"
import {
  persistWorkspaceChatUserTurnListed,
  resolveWorkspaceChatSendRuntime,
} from "../../domain/workspaces/workspace-chat-send-runtime.js"
import { discardUnstartedConversation } from "../../models/conversations.js"
import { createLogger, log, loggerStorage } from "../../observability/logger.js"

const WORKSPACE_CHAT_WS_PATH =
  /^\/([^/]+)\/api\/v1\/conversations\/([^/]+)(?:\/stream)?$/

export function parseConversationWebSocketUpgradeUrl(
  url: string,
): { orgSlug: string; conversationId: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const match = parsed.pathname.match(WORKSPACE_CHAT_WS_PATH)
  const orgSlug = match?.[1]
  const conversationId = match?.[2]
  if (!orgSlug || !conversationId) return null
  return { orgSlug, conversationId }
}

export function isWorkspaceChatWebSocketRequest(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return false
  }
  return WORKSPACE_CHAT_WS_PATH.test(new URL(request.url).pathname)
}

export type ConversationWebSocketData = {
  kind: "workspace-chat"
  orgSlug: string
  orgId: string
  conversationId: string
  userId: string
  request: Request
  socket: BunWebSocketLike
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
  close: (code?: number, reason?: string) => void
}

type MessageHandler = (ev: { data: unknown }) => void
type CloseHandler = () => void

export type BunWebSocketLike = WebSocketLike & {
  dispatchMessage: (data: string) => void
  dispatchClose: () => void
  dispatchError: () => void
}

export function bunSocketToWebSocketLike(ws: {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}): BunWebSocketLike {
  const messageHandlers: MessageHandler[] = []
  const closeHandlers: CloseHandler[] = []
  const errorHandlers: CloseHandler[] = []
  return {
    send: (data) => {
      ws.send(data)
    },
    close: (code, reason) => {
      ws.close(code, reason)
    },
    addEventListener(type, handler) {
      if (type === "message") {
        messageHandlers.push(handler as MessageHandler)
        return
      }
      if (type === "close") {
        closeHandlers.push(handler as CloseHandler)
        return
      }
      errorHandlers.push(handler as CloseHandler)
    },
    dispatchMessage(data) {
      for (const handler of messageHandlers) handler({ data })
    },
    dispatchClose() {
      for (const handler of closeHandlers) handler()
    },
    dispatchError() {
      for (const handler of errorHandlers) handler()
    },
  }
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

  const socket = bunSocketToWebSocketLike({
    send: () => {
      /* replaced after upgrade */
    },
    close: () => {
      /* replaced after upgrade */
    },
  })
  const upgraded = server.upgrade(request, {
    data: {
      kind: "workspace-chat",
      orgSlug,
      orgId: org.id,
      conversationId,
      userId: authSession.user.id,
      request,
      socket,
    },
  })
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 })
  }
  return undefined
}

export const conversationWebSocketHandlers = {
  open(ws: ChatSocket) {
    const like = ws.data.socket
    like.send = (data) => {
      ws.send(data)
    }
    like.close = (code, reason) => {
      ws.close(code, reason)
    }
    toWebSocketStream(like, ws.data.request, {
      durability: (ctx) => memoryStream(ctx.request),
      onRun: (ctx) =>
        streamWorkspaceChatSocketTurn({
          conversationId: ws.data.conversationId,
          orgId: ws.data.orgId,
          orgSlug: ws.data.orgSlug,
          userId: ws.data.userId,
          messages: ctx.messages,
          threadId: ctx.threadId,
          runId: ctx.runId,
          forwardedProps: ctx.forwardedProps,
          signal: ctx.signal,
        }),
    })
  },

  message(ws: ChatSocket, raw: string | ArrayBuffer | Uint8Array) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    ws.data.socket.dispatchMessage(text)
  },

  close(ws: ChatSocket) {
    ws.data.socket.dispatchClose()
  },
}

async function* streamWorkspaceChatSocketTurn(input: {
  conversationId: string
  orgId: string
  orgSlug: string
  userId: string
  messages: unknown
  threadId: string
  runId: string
  forwardedProps?: Record<string, unknown>
  signal: AbortSignal
}) {
  // toWebSocketStream already validated the official run. Reconstruct the
  // same AG-UI body (tools/context/state are required arrays/objects) so the
  // shared HTTP parser can extract the prompt without a second-frame failure.
  const body = {
    messages: input.messages,
    threadId: input.threadId,
    runId: input.runId,
    tools: [],
    context: [],
    state: {},
    forwardedProps: input.forwardedProps ?? {},
  }
  let parsed: ConversationChatRequest
  try {
    parsed = await parseConversationChatRequest(body)
  } catch (error) {
    log.error({
      step: "workspace-chat-ws-parse",
      message:
        error instanceof Error ? error.message : String(error),
    })
    yield workspaceChatRunError("Invalid AG-UI frame")
    return
  }
  if (!parsed.prompt || !parsed.workspaceId.trim()) {
    yield workspaceChatRunError("workspace_required")
    return
  }
  yield* withAuthContextStream(
    { id: input.orgId, slug: input.orgSlug },
    input.userId,
    input.conversationId,
    streamTanstackWorkspaceChat({
      conversationId: input.conversationId,
      prompt: parsed.prompt,
      messages: parsed.messages,
      threadId: parsed.threadId ?? input.conversationId,
      runId: parsed.runId ?? input.runId,
      abortSignal: input.signal,
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      workspaceId: parsed.workspaceId,
      writeStatus: "read_only",
      resolveRuntime: () =>
        resolveWorkspaceChatSendRuntime({
          conversationId: input.conversationId,
          workspaceId: parsed.workspaceId,
          source: parsed.source,
        }),
      onUserPersist: () =>
        persistWorkspaceChatUserTurnListed(input.conversationId),
      onError: async () => {
        if (!(await conversationHasStoredTurns(input.conversationId))) {
          await discardUnstartedConversation(input.conversationId)
        }
      },
    }),
  )
}

async function* withAuthContextStream<T>(
  org: { id: string; slug: string },
  userId: string,
  conversationId: string,
  stream: AsyncIterable<T>,
): AsyncGenerator<T> {
  const logger = createLogger({
    step: "workspace-chat-ws",
    conversationId,
    orgSlug: org.slug,
  })
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await loggerStorage.run(logger, () =>
        withOrgIdContext(org, () =>
          withUserIdContext(userId, () => iterator.next()),
        ),
      )
      if (next.done) return
      yield next.value
    }
  } finally {
    logger.emit()
  }
}
