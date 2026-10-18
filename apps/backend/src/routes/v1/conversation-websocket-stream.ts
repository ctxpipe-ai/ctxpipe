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

type ConversationChatSocketRun = Parameters<
  typeof toWebSocketStream
>[2]["onRun"]

/**
 * Start a turn or a resume on a chat socket. The run log key holds the
 * organization and the conversation of the socket, so a resume finds only a
 * run of that conversation. A run of another conversation fails as an
 * unknown run.
 */
export function startConversationChatSocket(
  socket: WebSocketLike,
  request: Request,
  scope: { orgId: string; conversationId: string },
  onRun: ConversationChatSocketRun,
  transport: {
    resume: typeof resumeWebSocketStream
    stream: typeof toWebSocketStream
  } = {
    resume: resumeWebSocketStream,
    stream: toWebSocketStream,
  },
) {
  const runLog = (runId: string) =>
    `${scope.orgId}/${scope.conversationId}/${runId}`
  if (conversationWebSocketHasResumeOffset(request.url)) {
    const query = new URL(request.url).searchParams
    transport.resume(socket, {
      adapter: memoryStream({
        runId: runLog(query.get("runId") ?? ""),
        offset: query.get("offset"),
      }),
    })
    return "resume" as const
  }
  transport.stream(socket, request, {
    durability: (ctx) => memoryStream({ runId: runLog(ctx.runId) }),
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
