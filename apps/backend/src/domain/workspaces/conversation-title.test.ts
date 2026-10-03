import { describe, expect, it } from "vitest"
import {
  conversationTitleFromModel,
  isUnnamedConversation,
} from "./conversation-title.js"

describe("isUnnamedConversation", () => {
  it("treats empty and default labels as unnamed", () => {
    expect(isUnnamedConversation(undefined)).toBe(true)
    expect(isUnnamedConversation("")).toBe(true)
    expect(isUnnamedConversation("New conversation")).toBe(true)
    expect(isUnnamedConversation("New Chat")).toBe(true)
    expect(isUnnamedConversation("Repo layout")).toBe(false)
  })
})

describe("conversationTitleFromModel", () => {
  it("uses the model title when present", () => {
    expect(conversationTitleFromModel("  Billing ledger  ", "hi")).toBe(
      "Billing ledger",
    )
  })

  it("falls back to the truncated first user message", () => {
    expect(conversationTitleFromModel("", "x".repeat(150))).toBe("x".repeat(80))
  })

  it("ignores a model title that is still the unnamed label", () => {
    expect(conversationTitleFromModel("New Chat", "Where is billing?")).toBe(
      "Where is billing?",
    )
  })
})
