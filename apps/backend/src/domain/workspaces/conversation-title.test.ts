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
    expect(conversationTitleFromModel("", "x".repeat(150))).toBe("x".repeat(72))
  })

  it("ignores a model title that is still the unnamed label", () => {
    expect(conversationTitleFromModel("New Chat", "Where is billing?")).toBe(
      "Where is billing?",
    )
  })

  it("keeps only the first line of a multi-line reply", () => {
    expect(
      conversationTitleFromModel(
        "Referral bonus docs\n\nI added the file because",
        "hi",
      ),
    ).toBe("Referral bonus docs")
  })

  it("removes quotes, a heading mark, a label and a trailing period", () => {
    expect(conversationTitleFromModel('"Billing ledger."', "hi")).toBe(
      "Billing ledger",
    )
    expect(conversationTitleFromModel("# Title: `Billing ledger`", "hi")).toBe(
      "Billing ledger",
    )
  })

  it("does not accept a sentence as a title", () => {
    expect(
      conversationTitleFromModel(
        "I'll inspect the repository, find the loyalty docs, and add the referral bonus page\n\nRe",
        "Add a referral bonus page",
      ),
    ).toBe("Add a referral bonus page")
  })

  it("cuts a long fallback at a word, to at most 72 characters", () => {
    const title = conversationTitleFromModel(
      "",
      `Please ${"document the referral program ".repeat(6)}`,
    )
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title).toMatch(/program$|document$|the$|referral$/)
    expect(title).not.toContain("\n")
  })

  it("uses the first line of the user message as the fallback", () => {
    expect(
      conversationTitleFromModel("", "Add a referral page.\nIt should link"),
    ).toBe("Add a referral page")
  })

  it("falls back to Conversation when both texts are empty", () => {
    expect(conversationTitleFromModel("  \n ", "  ")).toBe("Conversation")
  })

  it("masks a credential in the first user message", () => {
    const title = conversationTitleFromModel(
      "",
      "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to clone it",
    )
    expect(title).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    expect(title).toContain("[masked]")
  })
})
