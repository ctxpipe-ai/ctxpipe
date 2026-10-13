import { describe, expect, it } from "vitest"
import {
  estimateTokens,
  HARD_CAP_CHARS,
  pageWithinBudget,
  truncateText,
} from "./budget.js"
import { McpToolError } from "./tool-errors.js"
import { TOOL_ERROR_META_KEY, toolFailure, toolSuccess } from "./tool-result.js"

const measure = (item: string) => item

describe("estimateTokens", () => {
  it("counts about four characters for each token", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })
})

describe("pageWithinBudget", () => {
  const items = Array.from({ length: 10 }, (_, index) =>
    `${index}`.padEnd(40, "x"),
  )

  it("stops at the limit and gives the next offset", () => {
    expect(
      pageWithinBudget(items, { limit: 3, maxTokens: 4_000, measure }),
    ).toEqual({ page: items.slice(0, 3), nextOffset: 3, truncated: false })
  })

  it("starts at the offset and gives no next offset at the end", () => {
    expect(
      pageWithinBudget(items, {
        offset: 8,
        limit: 5,
        maxTokens: 4_000,
        measure,
      }),
    ).toEqual({ page: items.slice(8), nextOffset: null, truncated: false })
  })

  it("stops at the token budget and marks the page truncated", () => {
    // Each item is 40 characters = 10 tokens.
    const result = pageWithinBudget(items, {
      limit: 10,
      maxTokens: 35,
      measure,
    })
    expect(result).toEqual({
      page: items.slice(0, 3),
      nextOffset: 3,
      truncated: true,
    })
  })

  it("keeps one item over budget so each page makes progress", () => {
    const result = pageWithinBudget(["x".repeat(400)], {
      limit: 10,
      maxTokens: 10,
      measure,
    })
    expect(result.page).toHaveLength(1)
    expect(result.nextOffset).toBeNull()
  })

  it("gives an empty page past the end", () => {
    expect(
      pageWithinBudget(items, {
        offset: 50,
        limit: 5,
        maxTokens: 100,
        measure,
      }),
    ).toEqual({ page: [], nextOffset: null, truncated: false })
  })
})

describe("truncateText", () => {
  it("keeps short text and cuts long text with a marker", () => {
    expect(truncateText("short", 10)).toBe("short")
    const cut = truncateText("a".repeat(50), 20)
    expect(cut.length).toBeLessThanOrEqual(20)
    expect(cut.endsWith("…")).toBe(true)
  })
})

describe("toolSuccess", () => {
  it("returns structuredContent and compact TOON text", () => {
    const result = toolSuccess({
      served: { branch: "main", sha: "4f2c1e9" },
      hits: [
        { ref: "knowledge/a.md", score: 0.5 },
        { ref: "knowledge/b.md", score: 0.25 },
      ],
    })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      served: { branch: "main" },
    })
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("hits[2]{ref,score}:")
    expect(text).toContain("knowledge/a.md,0.5")
    expect(text).not.toContain('{"')
  })

  it("never sends text over the hard cap", () => {
    const result = toolSuccess({
      rows: Array.from({ length: 2_000 }, (_, index) => ({
        ref: `knowledge/${index}.md`,
        snippet: "y".repeat(80),
      })),
    })
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text.length).toBeLessThanOrEqual(HARD_CAP_CHARS)
    expect(text).toContain("truncated")
  })
})

describe("toolFailure", () => {
  it("returns isError with code, message, and retryable", () => {
    const result = toolFailure(new McpToolError("stale_cursor", "Start again."))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result._meta?.[TOOL_ERROR_META_KEY]).toEqual({
      code: "stale_cursor",
      message: "Start again.",
      retryable: false,
    })
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("stale_cursor")
    expect(text).toContain("Start again.")
  })
})
