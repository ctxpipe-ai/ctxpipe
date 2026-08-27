import { type SubscribeConnectionAdapter, webSocket } from "@tanstack/ai-react"

export function workspaceChatSocketPath(
  orgSlug: string,
  conversationId: string,
) {
  return `/${orgSlug}/api/v1/conversations/${conversationId}`
}

type EagerSocket = {
  warm: () => void
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
  let warmed: WebSocket | undefined

  function reuseOrCreate(
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const target = String(url)
    if (
      warmed &&
      warmed.readyState <= WebSocket.OPEN &&
      shouldReuseWarmedWorkspaceChatSocket(warmed.url, target)
    ) {
      return warmed
    }
    warmed = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    return warmed
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
      if (typeof fetch === "undefined") return emptyChatHydration()
      const res = await fetch(
        `${path}/chat?threadId=${encodeURIComponent(threadId)}`,
        {
          headers: { Accept: "application/json" },
          credentials: "include",
        },
      )
      if (!res.ok) return emptyChatHydration()
      const data = (await res.json()) as Partial<ChatHydrationResult>
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
      if (warmed && warmed.readyState <= WebSocket.OPEN) return
      warmed = new WebSocket(absoluteWebSocketUrl(path))
    },
  }
}

export function workspaceChatSocketIsResume(url: string): boolean {
  try {
    const parsed = new URL(url, "http://localhost")
    return (
      parsed.searchParams.has("offset") || parsed.searchParams.has("runId")
    )
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
