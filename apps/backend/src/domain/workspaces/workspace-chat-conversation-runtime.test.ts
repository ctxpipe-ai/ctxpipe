import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getWorkspaceChatConversationRuntime,
  releaseWorkspaceChatConversationRuntime,
  resetWorkspaceChatConversationRuntimes,
  setWorkspaceChatConversationRuntime,
} from "./workspace-chat-conversation-runtime.js"

function runtime(conversationId: string) {
  return {
    conversationId,
    runToken: "tok",
    proxy: {
      baseUrl: "http://127.0.0.1:18789",
      close: vi.fn(async () => {}),
    },
    proxyLease: null,
    servePort: 4097,
    servePortLease: null,
    tools: [],
    toolBridge: null,
    sessionId: null,
    serve: null,
  }
}

describe("workspace chat conversation runtime", () => {
  afterEach(() => {
    resetWorkspaceChatConversationRuntimes()
  })

  it("reuses one runtime per conversation", () => {
    const first = setWorkspaceChatConversationRuntime(runtime("conv_a"))
    expect(getWorkspaceChatConversationRuntime("conv_a")).toBe(first)
    expect(getWorkspaceChatConversationRuntime("conv_b")).toBeNull()
  })

  it("closes the proxy and tool bridge when the conversation runtime is released", async () => {
    const created = setWorkspaceChatConversationRuntime({
      ...runtime("conv_close"),
      toolBridge: {
        name: "tanstack",
        url: "http://127.0.0.1:9/mcp",
        token: "tok",
        close: vi.fn(async () => {}),
      },
    })
    await releaseWorkspaceChatConversationRuntime("conv_close")
    expect(created.proxy.close).toHaveBeenCalledTimes(1)
    expect(created.toolBridge?.close).toHaveBeenCalledTimes(1)
    expect(getWorkspaceChatConversationRuntime("conv_close")).toBeNull()
  })
})
