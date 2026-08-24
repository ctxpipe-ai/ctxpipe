import { describe, expect, it } from "vitest"
import { workspaceChatSocketPath } from "./workspaceChatWebSocket"

describe("workspaceChatSocketPath", () => {
  it("builds the org-scoped conversation websocket path", () => {
    expect(workspaceChatSocketPath("acme", "conv_1")).toBe(
      "/acme/api/v1/conversations/conv_1",
    )
  })
})
