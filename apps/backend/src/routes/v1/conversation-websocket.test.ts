import { describe, expect, it, vi } from "vitest"
import {
  bunSocketToWebSocketLike,
  conversationWebSocketHasResumeOffset,
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
  startConversationChatSocket,
} from "./conversation-websocket-stream.js"

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
        new Request("http://localhost:3000/acme/api/v1/conversations/conv_1", {
          headers: { upgrade: "websocket" },
        }),
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

describe("workspace chat websocket resume", () => {
  it("treats a handshake offset as a durability replay", () => {
    expect(
      conversationWebSocketHasResumeOffset(
        "http://localhost:3000/acme/api/v1/conversations/conv_1?runId=run_1&offset=-1",
      ),
    ).toBe(true)
    expect(
      conversationWebSocketHasResumeOffset(
        "http://localhost:3000/acme/api/v1/conversations/conv_1",
      ),
    ).toBe(false)
  })

  it("replays the durability log instead of starting onRun", () => {
    const resume = vi.fn()
    const stream = vi.fn()
    const onRun = vi.fn()
    const socket = bunSocketToWebSocketLike({
      send: vi.fn(),
      close: vi.fn(),
    })
    expect(
      startConversationChatSocket(
        socket,
        new Request(
          "http://localhost:3000/acme/api/v1/conversations/conv_1?runId=run_1&offset=-1",
        ),
        onRun,
        { resume, stream },
      ),
    ).toBe("resume")
    expect(resume).toHaveBeenCalledTimes(1)
    expect(stream).not.toHaveBeenCalled()
    expect(onRun).not.toHaveBeenCalled()
  })

  it("starts a fresh turn when the handshake has no offset", () => {
    const resume = vi.fn()
    const stream = vi.fn()
    const onRun = vi.fn()
    const socket = bunSocketToWebSocketLike({
      send: vi.fn(),
      close: vi.fn(),
    })
    expect(
      startConversationChatSocket(
        socket,
        new Request("http://localhost:3000/acme/api/v1/conversations/conv_1"),
        onRun,
        { resume, stream },
      ),
    ).toBe("run")
    expect(stream).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })
})
