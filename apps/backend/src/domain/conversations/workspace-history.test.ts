import { beforeEach, describe, expect, it, vi } from "vitest"

const loadTurnsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: loadTurnsMock,
}))

vi.mock("../../graphs/index.js", () => ({
  conversationGraph: {},
}))

vi.mock("../../observability/langfuse.js", () => ({
  getLangfuseHandler: vi.fn(),
  runWithLangfuseContext: (_meta: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock("../workspaces/tanstack-workspace-chat.js", () => ({
  runTanstackWorkspaceChat: vi.fn(),
}))

import { loadConversationUiMessages } from "./transport.js"

describe("loadConversationUiMessages", () => {
  beforeEach(() => {
    loadTurnsMock.mockReset()
  })

  it("loads Workspace turns from Postgres instead of LangGraph", async () => {
    loadTurnsMock.mockResolvedValueOnce([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
    const messages = await loadConversationUiMessages({
      conversationId: "conv_1",
      checkpointNamespace: "",
      workspaceId: "ws_1",
    })
    expect(loadTurnsMock).toHaveBeenCalledWith("conv_1")
    expect(messages).toEqual([
      {
        id: "conv_1:0",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "conv_1:1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
      },
    ])
  })
})
