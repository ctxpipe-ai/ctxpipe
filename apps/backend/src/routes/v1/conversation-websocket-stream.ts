import {
  memoryStream,
  resumeWebSocketStream,
  toWebSocketStream,
  type WebSocketLike,
} from "@tanstack/ai"

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

export function conversationWebSocketHasResumeOffset(url: string): boolean {
  try {
    return new URL(url).searchParams.get("offset") !== null
  } catch {
    return false
  }
}

type ConversationChatSocketRun = (ctx: {
  messages: unknown
  threadId: string
  runId: string
  forwardedProps?: Record<string, unknown>
  signal: AbortSignal
  request: Request
}) => AsyncIterable<unknown>

export function startConversationChatSocket(
  socket: WebSocketLike,
  request: Request,
  onRun: ConversationChatSocketRun,
  transport: {
    resume: typeof resumeWebSocketStream
    stream: typeof toWebSocketStream
  } = {
    resume: resumeWebSocketStream,
    stream: toWebSocketStream,
  },
) {
  if (conversationWebSocketHasResumeOffset(request.url)) {
    transport.resume(socket, { adapter: memoryStream(request) })
    return "resume" as const
  }
  transport.stream(socket, request, {
    durability: (ctx) => memoryStream(ctx.request),
    onRun,
  })
  return "run" as const
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
