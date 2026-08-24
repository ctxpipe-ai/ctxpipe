import { describe, expect, it } from "vitest"
import {
  formatWorkspaceChatHits,
  workspaceChatHybridHits,
  workspaceChatRetrievalSnippets,
} from "./workspace-chat-retrieval.js"

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

  it("requires an active projection SHA and fuses lexical plus vector hits", () => {
    expect(
      workspaceChatHybridHits({
        query: "billing ledger",
        activeProjectionSha: null,
        units: [
          {
            servingId: "kn_1",
            path: "knowledge/billing/ledger.md",
            body: "The billing ledger.",
          },
        ],
      }),
    ).toEqual([])
    const hits = workspaceChatHybridHits({
      query: "billing",
      activeProjectionSha: "abc",
      embedding: [1, 0],
      units: [
        {
          servingId: "kn_1",
          path: "knowledge/billing/ledger.md",
          body: "The billing ledger.",
          projectionSha: "abc",
          embedding: [1, 0],
        },
        {
          servingId: "kn_2",
          path: "knowledge/auth/login.md",
          body: "Login flow.",
          projectionSha: "old",
          embedding: [0, 1],
        },
      ],
    })
    expect(hits.map((hit) => hit.path)).toEqual(["knowledge/billing/ledger.md"])
  })

  it("ranks and formats claims from the active projection", () => {
    const hits = workspaceChatHybridHits({
      query: "ledger owner",
      activeProjectionSha: "abc",
      units: [
        {
          servingId: "kn_1",
          path: "knowledge/billing/ledger.md",
          body: "The billing ledger.",
          claims: [{ to: "alice", predicate: "OWNED_BY" }],
        },
      ],
    })
    expect(hits[0]?.claims).toEqual([{ to: "alice", predicate: "OWNED_BY" }])
    expect(
      formatWorkspaceChatHits({ activeProjectionSha: "abc", hits }),
    ).toContain("OWNED_BY alice")
  })
})
