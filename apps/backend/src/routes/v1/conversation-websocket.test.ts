import { describe, expect, it, vi } from "vitest"
import {
  bunSocketToWebSocketLike,
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
} from "./conversation-websocket.js"

describe("workspace chat official websocket hosting", () => {
  it("matches the conversation upgrade path and ignores Vite HMR", () => {
    expect(
      parseConversationWebSocketUpgradeUrl(
        "http://localhost:3000/acme/api/v1/conversations/conv_1",
      ),
    ).toEqual({ orgSlug: "acme", conversationId: "conv_1" })
    expect(
      isWorkspaceChatWebSocketRequest(
        new Request("http://localhost:3000/@vite/client", {
          headers: { upgrade: "websocket" },
        }),
      ),
    ).toBe(false)
    expect(
      isWorkspaceChatWebSocketRequest(
        new Request(
          "http://localhost:3000/acme/api/v1/conversations/conv_1",
          { headers: { upgrade: "websocket" } },
        ),
      ),
    ).toBe(true)
  })

  it("adapts a Bun-style socket to WebSocketLike", () => {
    const sent: string[] = []
    const like = bunSocketToWebSocketLike({
      send: (data) => {
        sent.push(data)
      },
      close: vi.fn(),
    })
    const messages: unknown[] = []
    like.addEventListener("message", (ev) => {
      messages.push(ev.data)
    })
    like.send("ping")
    like.dispatchMessage("hello")
    expect(sent).toEqual(["ping"])
    expect(messages).toEqual(["hello"])
  })
})
