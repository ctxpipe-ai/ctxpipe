import type { ModelMessage, StreamChunk } from "@tanstack/ai"
import type {
  ConnectionAdapter,
  RunAgentInputContext,
  UIMessage,
} from "@tanstack/ai-react"

const WS_OPEN_TIMEOUT_MS = 1_200

export function workspaceChatHttpPath(input: {
  orgSlug: string
  conversationId: string
}): string {
  return `/${input.orgSlug}/api/v1/conversations/${input.conversationId}`
}

export function workspaceChatWebSocketUrl(httpPath: string): string {
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin
  const url = new URL(httpPath, origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export function shouldFallbackFromWebSocket(error: unknown): boolean {
  if (!(error instanceof Error)) return true
  return (
    error.name === "WorkspaceChatWebSocketUnavailable" ||
    error.message.includes("WebSocket") ||
    error.message.includes("failed to connect")
  )
}

function mergeRunContext(
  runContext: RunAgentInputContext | undefined,
  workspaceId: string,
): RunAgentInputContext {
  return {
    threadId: runContext?.threadId ?? "",
    runId: runContext?.runId ?? "",
    parentRunId: runContext?.parentRunId,
    resume: runContext?.resume,
    clientTools: runContext?.clientTools,
    forwardedProps: {
      ...runContext?.forwardedProps,
      workspaceId,
      source: "ui",
    },
  }
}

async function* connectWorkspaceChatWebSocket(
  httpPath: string,
  messages: Array<UIMessage> | Array<ModelMessage>,
  abortSignal: AbortSignal | undefined,
  runContext: RunAgentInputContext,
): AsyncIterable<StreamChunk> {
  if (typeof WebSocket === "undefined") {
    throw Object.assign(new Error("WebSocket is not available"), {
      name: "WorkspaceChatWebSocketUnavailable",
    })
  }
  const socket = new WebSocket(workspaceChatWebSocketUrl(httpPath))
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WS_OPEN_TIMEOUT_MS)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve(true)
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
    abortSignal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  if (!opened) {
    socket.close()
    throw Object.assign(new Error("WebSocket failed to connect"), {
      name: "WorkspaceChatWebSocketUnavailable",
    })
  }

  socket.send(
    JSON.stringify({
      threadId: runContext.threadId,
      runId: runContext.runId,
      parentRunId: runContext.parentRunId,
      messages,
      tools: runContext.clientTools ?? [],
      context: [],
      forwardedProps: runContext.forwardedProps ?? {},
    }),
  )

  const queue: StreamChunk[] = []
  let notify: (() => void) | null = null
  let closed = false
  let socketError: Error | null = null

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    try {
      queue.push(JSON.parse(event.data) as StreamChunk)
      notify?.()
    } catch {
      /* ignore non-JSON frames */
    }
  }
  const onClose = () => {
    closed = true
    notify?.()
  }
  const onError = () => {
    socketError = new Error("WebSocket closed")
    closed = true
    notify?.()
  }
  socket.addEventListener("message", onMessage)
  socket.addEventListener("close", onClose)
  socket.addEventListener("error", onError)
  abortSignal?.addEventListener("abort", () => socket.close())

  try {
    for (;;) {
      if (queue.length === 0) {
        if (closed) {
          if (socketError) throw socketError
          return
        }
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        continue
      }
      const chunk = queue.shift()
      if (!chunk) continue
      yield chunk
      if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") return
    }
  } finally {
    socket.removeEventListener("message", onMessage)
    socket.removeEventListener("close", onClose)
    socket.removeEventListener("error", onError)
    if (socket.readyState === WebSocket.OPEN) socket.close()
  }
}

export function createWorkspaceChatConnection(input: {
  orgSlug: string
  conversationId: string
  workspaceId: string
}): ConnectionAdapter {
  const httpPath = workspaceChatHttpPath(input)
  return {
    async *connect(messages, _data, abortSignal, runContext) {
      const context = mergeRunContext(runContext, input.workspaceId)
      try {
        yield* connectWorkspaceChatWebSocket(
          httpPath,
          messages,
          abortSignal,
          context,
        )
        return
      } catch (error) {
        if (!shouldFallbackFromWebSocket(error)) throw error
      }

      const { fetchServerSentEvents, fetchHttpStream } = await import(
        "@tanstack/ai-react"
      )
      try {
        yield* fetchServerSentEvents(httpPath, {
          credentials: "include",
        }).connect(messages, undefined, abortSignal, context)
        return
      } catch {
        yield* fetchHttpStream(httpPath, {
          credentials: "include",
        }).connect(messages, undefined, abortSignal, context)
      }
    },
  }
}
