import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getConversationMock,
  updateConversationMock,
  withOrgDbContextMock,
  getModelMock,
  invokeMock,
  getConfigMock,
} = vi.hoisted(() => ({
  getConversationMock: vi.fn(),
  updateConversationMock: vi.fn(),
  withOrgDbContextMock: vi.fn(
    async (_orgId: string, handler: () => Promise<unknown>) => handler(),
  ),
  getModelMock: vi.fn(),
  invokeMock: vi.fn(),
  getConfigMock: vi.fn(),
}))

vi.mock("../../../models/conversations.js", () => ({
  getConversation: getConversationMock,
  updateConversation: updateConversationMock,
}))

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../../../auth/context.js", () => ({
  requireCurrentOrgId: () => "org_test",
}))

vi.mock("../../../retrieval/services/modelProvider.js", () => ({
  getModel: getModelMock,
}))

vi.mock("@langchain/langgraph", () => ({
  getConfig: getConfigMock,
  getWriter: vi.fn(() => undefined),
}))

import { HumanMessage } from "@langchain/core/messages"
import { conversationNaming } from "./conversationNaming.js"

describe("conversationNaming", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConfigMock.mockReturnValue({
      configurable: { thread_id: "thr_1", source: "mcp" },
    })
    getConversationMock.mockResolvedValue({
      id: "thr_1",
      name: "New Chat",
    })
    updateConversationMock.mockResolvedValue({ id: "thr_1", name: "Auth Plan" })
    invokeMock.mockResolvedValue({ content: "Auth Plan" })
    getModelMock.mockReturnValue({ invoke: invokeMock })
    withOrgDbContextMock.mockImplementation(
      async (_orgId: string, handler: () => Promise<unknown>) => handler(),
    )
  })

  it("does not hold an org transaction across the title model call", async () => {
    const events: string[] = []
    withOrgDbContextMock.mockImplementation(
      async (_orgId: string, handler: () => Promise<unknown>) => {
        events.push("txn-enter")
        try {
          return await handler()
        } finally {
          events.push("txn-exit")
        }
      },
    )
    invokeMock.mockImplementation(async () => {
      events.push("llm")
      return { content: "Auth Plan" }
    })

    await conversationNaming({
      messages: [new HumanMessage("How should we structure auth?")],
    })

    expect(withOrgDbContextMock).toHaveBeenCalledWith(
      "org_test",
      expect.any(Function),
    )
    expect(getConversationMock).toHaveBeenCalledWith("thr_1")
    expect(updateConversationMock).toHaveBeenCalledWith("thr_1", {
      name: "Auth Plan",
    })
    let depth = 0
    let llmInsideTxn = false
    for (const event of events) {
      if (event === "txn-enter") depth += 1
      if (event === "txn-exit") depth -= 1
      if (event === "llm" && depth > 0) llmInsideTxn = true
    }
    expect(llmInsideTxn).toBe(false)
  })
})
