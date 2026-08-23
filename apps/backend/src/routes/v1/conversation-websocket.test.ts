import { describe, expect, it } from "vitest"
import {
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
  WORKSPACE_CHAT_WS_PATH,
} from "./conversation-websocket-url.js"

describe("workspace chat websocket path", () => {
  it("matches the product conversation stream and ignores Vite HMR", () => {
    expect(
      WORKSPACE_CHAT_WS_PATH.test(
        "/acme/api/v1/conversations/conv_agqcxxv4gb3abdn46ruf3f42xe",
      ),
    ).toBe(true)
    expect(WORKSPACE_CHAT_WS_PATH.test("/@vite/client")).toBe(false)
    expect(
      parseConversationWebSocketUpgradeUrl(
        "http://localhost:3000/acme/api/v1/conversations/conv_1",
      ),
    ).toEqual({ orgSlug: "acme", conversationId: "conv_1" })
    const request = new Request(
      "http://localhost:3000/acme/api/v1/conversations/conv_1",
      { headers: { upgrade: "websocket" } },
    )
    expect(isWorkspaceChatWebSocketRequest(request)).toBe(true)
    expect(
      isWorkspaceChatWebSocketRequest(
        new Request("http://localhost:3000/@vite/client", {
          headers: { upgrade: "websocket" },
        }),
      ),
    ).toBe(false)
  })
})
