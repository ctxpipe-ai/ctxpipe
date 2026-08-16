import { describe, expect, it } from "vitest"
import {
  displayNameFromAgentsMarkdown,
  hydrateIsNoop,
  hydrateKnowledgeTree,
  hydrateReadsStoredDesiredSha,
  hydrateUnitsToProjectionClaims,
  servingIdForKnowledgePath,
  shouldReplaceKnowledgeProjection,
  workspaceProjectionReady,
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

describe("workspaceProjectionReady", () => {
  it("is ready only after hydrate activates a SHA", () => {
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: null,
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: null,
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: "abc",
      }),
    ).toBe(true)
  })
})

describe("hydrateUnitsToProjectionClaims", () => {
  it("projects layer-2 claims and unresolved-safe LINKS_TO from units", () => {
    const api = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const ledger = servingIdForKnowledgePath(
      "ws_1",
      "knowledge/billing/ledger.md",
    )
    const claims = hydrateUnitsToProjectionClaims([
      {
        path: "knowledge/payments/api.md",
        servingId: api,
        body: "See [ledger](../billing/ledger.md).",
        links: ["../billing/ledger.md"],
        claims: [
          {
            to: "../billing/ledger.md",
            predicate: "DEPENDS_ON",
            confidence: 0.8,
            validFrom: "2026-01-01",
            validTo: null,
            source: "git",
          },
        ],
      },
      {
        path: "knowledge/billing/ledger.md",
        servingId: ledger,
        body: "Ledger",
        links: [],
        claims: [],
      },
    ])
    expect(claims).toEqual([
      expect.objectContaining({
        subjectId: api,
        objectId: ledger,
        predicate: "DEPENDS_ON",
        aggregatedConfidence: 0.8,
      }),
    ])
  })
})

describe("hydrateReadsStoredDesiredSha", () => {
  it("reads the stored desired SHA, not a moving default branch", () => {
    expect(hydrateReadsStoredDesiredSha("abc123")).toBe("abc123")
    expect(hydrateReadsStoredDesiredSha("  ")).toBeNull()
    expect(hydrateReadsStoredDesiredSha(null)).toBeNull()
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
