import { type SubscribeConnectionAdapter, webSocket } from "@tanstack/ai-react"
import { apiFetch, readApiJson } from "@/lib/api-result"

export function workspaceChatSocketPath(
  orgSlug: string,
  conversationId: string,
) {
  return `/${orgSlug}/api/v1/conversations/${conversationId}`
}

type EagerSocket = {
  warm: () => void
  dispose: () => void
}

type ChatHydrationResult = Awaited<
  ReturnType<NonNullable<SubscribeConnectionAdapter["hydrate"]>>
>

function emptyChatHydration(): ChatHydrationResult {
  return { messages: [], activeRun: null, interrupts: null }
}

/**
 * Official TanStack `webSocket()` with handshake started on compose mount.
 * Reuses the already-open socket for the first Send (same path, ignore search).
 */
export function workspaceChatWebSocket(
  orgSlug: string,
  conversationId: string,
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
    if (
      warmed &&
      warmed.readyState <= 1 &&
      shouldReuseWarmedWorkspaceChatSocket(warmed.url, target)
    ) {
      return warmed
    }
    const socket = track(
      protocols ? new WebSocket(url, protocols) : new WebSocket(url),
    )
    warmed = socket
    return socket
  }

  const connection = webSocket(path, {
    WebSocketImpl: function WorkspaceChatWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ) {
      return reuseOrCreate(url, protocols)
    } as unknown as typeof WebSocket,
  })

  return {
    ...connection,
    async hydrate(threadId: string) {
      const res = await apiFetch(
        `${path}/chat?threadId=${encodeURIComponent(threadId)}`,
        {
          headers: { Accept: "application/json" },
          credentials: "include",
        },
      )
      if (res.status === 404) return emptyChatHydration()
      const data = await readApiJson<Partial<ChatHydrationResult>>(res, {
        message: "Failed to load conversation",
      })
      return {
        messages: Array.isArray(data.messages) ? data.messages : [],
        activeRun:
          data.activeRun && typeof data.activeRun.runId === "string"
            ? { runId: data.activeRun.runId }
            : null,
        interrupts: data.interrupts ?? null,
      }
    },
    warm() {
      if (typeof WebSocket === "undefined") return
      if (warmed && warmed.readyState <= 1) return
      warmed = track(new WebSocket(absoluteWebSocketUrl(path)))
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

export function workspaceChatSocketIsResume(url: string): boolean {
  try {
    const parsed = new URL(url, "http://localhost")
    return parsed.searchParams.has("offset") || parsed.searchParams.has("runId")
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
