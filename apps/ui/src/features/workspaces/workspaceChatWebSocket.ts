import type { StreamChunk } from "@tanstack/ai"
import { type SubscribeConnectionAdapter, webSocket } from "@tanstack/ai-react"

import { reviveChatMessages } from "@/features/chat/reviveChatMessageCreatedAt"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export function workspaceChatSocketPath(
  orgSlug: string,
  conversationId: string,
) {
  return `/${orgSlug}/api/v1/conversations/${conversationId}`
}

type EagerSocket = {
  warm: () => void
  dispose: () => void
  /**
   * Stop a run on the server. The run continues when its socket closes, so
   * the Stop control must send the abort frame, also for a run that the chat
   * attached to again.
   */
  stopRun: (runId: string) => void
}

type ChatHydrationResult = Awaited<
  ReturnType<NonNullable<SubscribeConnectionAdapter["hydrate"]>>
>

function emptyChatHydration(): ChatHydrationResult {
  return { messages: [], activeRun: null, interrupts: null }
}

/**
 * Official TanStack `webSocket()` with handshake started on compose mount.
 * The first Send takes the socket that `warm()` opened (same path, ignore
 * search). No other send reuses it.
 */
export function workspaceChatWebSocket(
  orgSlug: string,
  conversationId: string,
  options?: {
    /** Called when the transcript load from the server ends. */
    onHydrated?: () => void
  },
): SubscribeConnectionAdapter &
  EagerSocket & {
    hydrate: NonNullable<SubscribeConnectionAdapter["hydrate"]>
  } {
  const path = workspaceChatSocketPath(orgSlug, conversationId)
  const sockets = new Set<WebSocket>()
  let warmed: WebSocket | undefined

  function track(socket: WebSocket): WebSocket {
    sockets.add(socket)
    return socket
  }

  function reuseOrCreate(
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const target = String(url)
    // Only the socket that `warm()` opened, and only once. A resume or join
    // socket never goes to a later run.
    if (
      warmed &&
      warmed.readyState <= 1 &&
      shouldReuseWarmedWorkspaceChatSocket(warmed.url, target)
    ) {
      const socket = warmed
      warmed = undefined
      return socket
    }
    return track(protocols ? new WebSocket(url, protocols) : new WebSocket(url))
  }

  const connection = webSocket(path, {
    WebSocketImpl: function WorkspaceChatWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ) {
      return reuseOrCreate(url, protocols)
    } as unknown as typeof WebSocket,
  })

  const subscribe = connection.subscribe
  const joinRun = connection.joinRun
  return {
    ...connection,
    subscribe: (abortSignal) => withReasoningSteps(subscribe(abortSignal)),
    ...(joinRun
      ? {
          joinRun: (runId: string, abortSignal?: AbortSignal) =>
            withReasoningSteps(joinRun(runId, abortSignal)),
        }
      : {}),
    async hydrate() {
      const res = await client[":orgSlug"].api.v1.conversations[
        ":conversationId"
      ].chat.$get(
        { param: { orgSlug, conversationId }, query: {} },
        { headers: { Accept: "application/json" } },
      )
      if (res.status === 404) {
        options?.onHydrated?.()
        return emptyChatHydration()
      }
      const data = await readApiJson(res, {
        message: "Failed to load conversation",
      })
      options?.onHydrated?.()
      return {
        messages: reviveChatMessages(
          (Array.isArray(data.messages) ? data.messages : []) as Array<{
            createdAt?: unknown
          }>,
        ) as ChatHydrationResult["messages"],
        activeRun:
          data.activeRun && typeof data.activeRun.runId === "string"
            ? { runId: data.activeRun.runId }
            : null,
        interrupts: (data.interrupts ??
          null) as ChatHydrationResult["interrupts"],
      }
    },
    warm() {
      if (typeof WebSocket === "undefined") return
      if (warmed && warmed.readyState <= 1) return
      warmed = track(new WebSocket(absoluteWebSocketUrl(path)))
    },
    stopRun(runId) {
      if (typeof WebSocket === "undefined") return
      const frame = JSON.stringify({ type: "abort", runId })
      const open = [...sockets].find((socket) => socket.readyState === 1)
      if (open) {
        open.send(frame)
        return
      }
      const socket = track(new WebSocket(absoluteWebSocketUrl(path)))
      socket.addEventListener(
        "open",
        () => {
          socket.send(frame)
          socket.close()
        },
        { once: true },
      )
    },
    dispose() {
      for (const socket of sockets) {
        socket.close()
      }
      sockets.clear()
      warmed = undefined
    },
  }
}

/**
 * Only an `offset` makes a resume, as on the backend. The first Send of a run
 * also has `?runId=`; it must use the warmed socket, because a new socket
 * adds a full handshake to the first turn.
 */
export function workspaceChatSocketIsResume(url: string): boolean {
  try {
    return new URL(url, "http://localhost").searchParams.has("offset")
  } catch {
    return false
  }
}

export function shouldReuseWarmedWorkspaceChatSocket(
  warmedUrl: string,
  targetUrl: string,
): boolean {
  return (
    sameWebSocketPath(warmedUrl, targetUrl) &&
    !workspaceChatSocketIsResume(targetUrl)
  )
}

function sameWebSocketPath(left: string, right: string): boolean {
  try {
    const a = new URL(left, "http://localhost")
    const b = new URL(right, "http://localhost")
    return a.pathname === b.pathname
  } catch {
    return left === right
  }
}

function absoluteWebSocketUrl(path: string): string {
  if (typeof window === "undefined") return path
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${path}`
}

/**
 * Starts a new step before each reasoning message. Without a step, the chat
 * client adds all reasoning of a turn to the first thinking part, so a late
 * thought shows above the tool calls that came before it.
 */
async function* withReasoningSteps(
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "REASONING_MESSAGE_START") {
      yield {
        type: "STEP_STARTED",
        stepName: chunk.messageId,
        timestamp: chunk.timestamp,
      } as StreamChunk
    }
    yield chunk
  }
}
