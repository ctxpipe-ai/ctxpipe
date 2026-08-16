import { describe, expect, it } from "vitest"
import {
  displayNameFromAgentsMarkdown,
  hydrateIsNoop,
  hydrateKnowledgeTree,
  servingIdForKnowledgePath,
  shouldReplaceKnowledgeProjection,
} from "./hydrate.js"

describe("hydrateKnowledgeTree", () => {
  it("uses a stable serving id per Workspace + path and skips malformed files", () => {
    const a = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const b = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const c = servingIdForKnowledgePath("ws_2", "knowledge/payments/api.md")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("kn_")).toBe(true)

    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/payments/api.md",
          content:
            "---\nclaims:\n  - to: ../billing/ledger.md\n    predicate: DEPENDS_ON\n---\nSee [ledger](../billing/ledger.md).\n",
        },
        { path: "broken.md", content: "---\nnot closed\n" },
        {
          path: "repositories/billing.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
        { path: "linear/issues/PAY-1.md", content: "mirror" },
      ],
    })
    expect(result.units).toHaveLength(1)
    expect(result.units[0]?.links).toEqual(["../billing/ledger.md"])
    expect(result.units[0]?.claims[0]?.to).toBe("../billing/ledger.md")
    expect(result.skipped).toEqual([{ path: "broken.md", reason: "malformed" }])
    expect(result.linked).toEqual([
      {
        path: "repositories/billing.md",
        git: "https://github.com/acme/billing",
        branch: null,
      },
    ])
  })

  it("keeps the first linked remote and skips duplicate git URLs", () => {
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "repositories/billing.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
        {
          path: "repositories/billing-dup.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
      ],
    })
    expect(result.linked).toHaveLength(1)
    expect(result.skipped).toEqual([
      { path: "repositories/billing-dup.md", reason: "malformed" },
    ])
  })

  it("is a no-op when the SHA is already hydrated", () => {
    expect(hydrateIsNoop("abc", "abc")).toBe(true)
    expect(hydrateIsNoop("abc", "def")).toBe(false)
    expect(
      shouldReplaceKnowledgeProjection({ previousSha: "abc", sha: "abc" }),
    ).toBe(false)
    expect(
      shouldReplaceKnowledgeProjection({ previousSha: "abc", sha: "def" }),
    ).toBe(true)
  })
})

describe("displayNameFromAgentsMarkdown", () => {
  it("reads a valid name and ignores malformed or empty files", () => {
    expect(displayNameFromAgentsMarkdown("---\nname: Docs\n---\n")).toBe("Docs")
    expect(displayNameFromAgentsMarkdown("---\nname:   \n---\n")).toBeNull()
    expect(displayNameFromAgentsMarkdown("---\nnot closed\n")).toBeNull()
    expect(displayNameFromAgentsMarkdown("# No front matter\n")).toBeNull()
  })
})
