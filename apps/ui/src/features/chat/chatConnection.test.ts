import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createWorkspaceChatConnection,
  shouldFallbackFromWebSocket,
  workspaceChatHttpPath,
  workspaceChatWebSocketUrl,
} from "./chatConnection"

describe("workspace chat connection", () => {
  it("builds the same conversation path for WS and HTTP fallback", () => {
    const path = workspaceChatHttpPath({
      orgSlug: "acme",
      conversationId: "conv_1",
    })
    expect(path).toBe("/acme/api/v1/conversations/conv_1")
    expect(workspaceChatWebSocketUrl(path)).toMatch(
      /^wss?:\/\/.+\/acme\/api\/v1\/conversations\/conv_1$/,
    )
  })

  it("falls back to SSE when the socket never opens", () => {
    expect(
      shouldFallbackFromWebSocket(
        Object.assign(new Error("WebSocket failed to connect"), {
          name: "WorkspaceChatWebSocketUnavailable",
        }),
      ),
    ).toBe(true)
    expect(shouldFallbackFromWebSocket(new Error("RUN_ERROR"))).toBe(false)
  })

  it("yields AG-UI frames from a successful WebSocket before RUN_FINISHED", async () => {
    const listeners = new Map<string, Array<(event: Event) => void>>()
    class FakeWebSocket {
      static OPEN = 1
      readyState = FakeWebSocket.OPEN
      sent: string[] = []
      addEventListener(type: string, handler: (event: Event) => void) {
        const bucket = listeners.get(type) ?? []
        bucket.push(handler)
        listeners.set(type, bucket)
      }
      removeEventListener(type: string, handler: (event: Event) => void) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((item) => item !== handler),
        )
      }
      send(data: string) {
        this.sent.push(data)
      }
      close() {
        for (const handler of listeners.get("close") ?? []) {
          handler(new Event("close"))
        }
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket)
    const connection = createWorkspaceChatConnection({
      orgSlug: "acme",
      conversationId: "conv_1",
      workspaceId: "ws_1",
    })
    if (!("connect" in connection)) {
      throw new Error("expected a connect adapter")
    }
    const chunks = connection.connect(
      [{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] }],
      undefined,
      undefined,
      {
        threadId: "conv_1",
        runId: "run_1",
        forwardedProps: { workspaceId: "ws_1", source: "ui" },
      },
    )
    const first = chunks[Symbol.asyncIterator]()
    const pending = first.next()
    for (const handler of listeners.get("open") ?? []) {
      handler(new Event("open"))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const handler of listeners.get("message") ?? []) {
      handler(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "RUN_STARTED", threadId: "conv_1" }),
        }),
      )
      handler(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "TEXT_MESSAGE_CONTENT",
            delta: "token",
          }),
        }),
      )
      handler(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "RUN_FINISHED", threadId: "conv_1" }),
        }),
      )
    }
    const events = [
      (await pending).value,
      (await first.next()).value,
      (await first.next()).value,
    ]
    expect(events.map((event) => event?.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      "RUN_FINISHED",
    ])
    expect(events[1]).toMatchObject({ delta: "token" })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
