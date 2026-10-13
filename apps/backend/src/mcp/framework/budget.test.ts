import { describe, expect, it } from "vitest"
import { estimateTokens, pageWithinBudget, truncateText } from "./budget.js"

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
  it("never splits a surrogate pair", () => {
    const text = "ab😀😀😀"
    for (let max = 1; max <= text.length; max += 1) {
      const cut = truncateText(text, max)
      expect(cut.length).toBeLessThanOrEqual(max)
      expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(() => encodeURIComponent(cut)).not.toThrow()
    }
  })

  it("keeps short text and cuts long text with a marker", () => {
    expect(truncateText("short", 10)).toBe("short")
    const cut = truncateText("a".repeat(50), 20)
    expect(cut.length).toBeLessThanOrEqual(20)
    expect(cut.endsWith("…")).toBe(true)
  })
})
