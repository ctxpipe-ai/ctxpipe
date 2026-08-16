import { describe, expect, it } from "vitest"
import { workspaceChatRetrievalSnippets } from "./workspace-chat-retrieval.js"

describe("workspaceChatRetrievalSnippets", () => {
  it("ranks matching knowledge units for the chat prompt", () => {
    expect(
      workspaceChatRetrievalSnippets({
        query: "billing ledger",
        units: [
          { path: "knowledge/billing/ledger.md", body: "The billing ledger." },
          { path: "knowledge/auth/login.md", body: "Login flow." },
        ],
      }),
    ).toContain("knowledge/billing/ledger.md")
    expect(
      workspaceChatRetrievalSnippets({
        query: "billing ledger",
        units: [
          { path: "knowledge/billing/ledger.md", body: "The billing ledger." },
          { path: "knowledge/auth/login.md", body: "Login flow." },
        ],
      }),
    ).not.toContain("knowledge/auth/login.md")
    expect(
      workspaceChatRetrievalSnippets({
        query: "zzz",
        units: [{ path: "knowledge/a.md", body: "Hello" }],
      }),
    ).toBe("")
  })
})
