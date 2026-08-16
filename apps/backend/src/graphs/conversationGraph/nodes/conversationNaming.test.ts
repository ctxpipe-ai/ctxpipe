import { HumanMessage } from "@langchain/core/messages"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getConversationMock = vi.hoisted(() => vi.fn())
const updateConversationMock = vi.hoisted(() => vi.fn())
const getModelMock = vi.hoisted(() => vi.fn())
const getConfigMock = vi.hoisted(() => vi.fn())
const getWriterMock = vi.hoisted(() => vi.fn())

vi.mock("@langchain/langgraph", () => ({
  getConfig: getConfigMock,
  getWriter: getWriterMock,
}))

vi.mock("../../../models/conversations.js", () => ({
  getConversation: getConversationMock,
  updateConversation: updateConversationMock,
}))

vi.mock("../../../retrieval/services/modelProvider.js", () => ({
  getModel: getModelMock,
}))

import {
  conversationNaming,
  conversationTitleFromModel,
  isUnnamedConversation,
  textFromMessageContent,
} from "./conversationNaming.js"

describe("isUnnamedConversation", () => {
  it("treats empty and default labels as unnamed", () => {
    expect(isUnnamedConversation(undefined)).toBe(true)
    expect(isUnnamedConversation("")).toBe(true)
    expect(isUnnamedConversation("New conversation")).toBe(true)
    expect(isUnnamedConversation("New Chat")).toBe(true)
    expect(isUnnamedConversation("Repo layout")).toBe(false)
  })
})

describe("textFromMessageContent", () => {
  it("joins text parts", () => {
    expect(
      textFromMessageContent([
        { type: "text", text: "Hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("Hello world")
  })
})

describe("conversationTitleFromModel", () => {
  it("uses the model title when present", () => {
    expect(
      conversationTitleFromModel("Repo layout", "How is the repo laid out?"),
    ).toBe("Repo layout")
  })

  it("falls back to the truncated first user message", () => {
    const first = "a".repeat(120)
    expect(conversationTitleFromModel("", first)).toBe("a".repeat(80))
    expect(
      conversationTitleFromModel("   ", "  Fix the slug unique index  "),
    ).toBe("Fix the slug unique index")
  })
})

describe("conversationNaming", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConfigMock.mockReturnValue({
      configurable: { thread_id: "conv_1", source: "ui" },
    })
    getWriterMock.mockReturnValue(vi.fn())
    getConversationMock.mockResolvedValue({
      id: "conv_1",
      name: "New conversation",
    })
    updateConversationMock.mockResolvedValue({ id: "conv_1" })
  })

  it("persists a model title once", async () => {
    getModelMock.mockReturnValue({
      invoke: vi.fn().mockResolvedValue({ content: "Repo layout" }),
    })

    const result = await conversationNaming({
      messages: [new HumanMessage("How is the repo laid out?")],
    })

    expect(result.conversationName).toBe("Repo layout")
    expect(updateConversationMock).toHaveBeenCalledWith("conv_1", {
      name: "Repo layout",
    })
  })

  it("persists the truncated fallback when the model throws", async () => {
    getModelMock.mockReturnValue({
      invoke: vi.fn().mockRejectedValue(new Error("model down")),
    })

    const result = await conversationNaming({
      messages: [new HumanMessage("Fix the slug unique index")],
    })

    expect(result.conversationName).toBe("Fix the slug unique index")
    expect(updateConversationMock).toHaveBeenCalledWith("conv_1", {
      name: "Fix the slug unique index",
    })
  })

  it("does not call the model when already named", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv_1",
      name: "Repo layout",
    })

    const result = await conversationNaming({
      messages: [new HumanMessage("How is the repo laid out?")],
    })

    expect(result).toEqual({})
    expect(getModelMock).not.toHaveBeenCalled()
    expect(updateConversationMock).not.toHaveBeenCalled()
  })
})
