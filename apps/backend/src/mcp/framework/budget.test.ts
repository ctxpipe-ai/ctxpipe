import { describe, expect, it } from "vitest"

import {
  estimateTokens,
  fitPage,
  HARD_CAP_CHARS,
  measureResult,
  shrinkItem,
  truncateText,
} from "./budget.js"
import { toolSuccess } from "./tool-result.js"

describe("estimateTokens", () => {
  it("counts about four characters for each token", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })
})

describe("fitPage", () => {
  const items = Array.from({ length: 10 }, (_, index) =>
    `${index}`.padEnd(40, "x"),
  )
  const result = (page: string[]) => ({ items: page })

  it("stops at the limit and gives the next offset", () => {
    expect(fitPage(items, { limit: 3, maxTokens: 4_000, result })).toEqual({
      page: items.slice(0, 3),
      nextOffset: 3,
      truncated: false,
      cut: false,
      dropped: [],
    })
  })

  it("starts at the offset and gives no next offset at the end", () => {
    expect(
      fitPage(items, { offset: 8, limit: 5, maxTokens: 4_000, result }),
    ).toEqual({
      page: items.slice(8),
      nextOffset: null,
      truncated: false,
      cut: false,
      dropped: [],
    })
  })

  it("gives an empty page past the end", () => {
    expect(
      fitPage(items, { offset: 50, limit: 5, maxTokens: 4_000, result }),
    ).toEqual({
      page: [],
      nextOffset: null,
      truncated: false,
      cut: false,
      dropped: [],
    })
  })

  it("stops at the token budget of the whole result and marks the page truncated", () => {
    const wide = (page: string[]) => ({ note: "n".repeat(200), items: page })
    const page = fitPage(items, { limit: 10, maxTokens: 190, result: wide })
    expect(page.page.length).toBeGreaterThan(0)
    expect(page.page.length).toBeLessThan(10)
    expect(page.truncated).toBe(true)
    expect(page.nextOffset).toBe(page.page.length)
    expect(measureResult(wide(page.page)).tokens).toBeLessThanOrEqual(190)
  })

  it("keeps a page inside the hard cap, counting the text and structuredContent", () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({
      ref: `knowledge/${index}.md`,
      snippet: "y".repeat(80),
    }))
    const page = fitPage(rows, {
      limit: 400,
      maxTokens: 100_000,
      result: (fitted) => ({ rows: fitted }),
    })
    expect(page.page.length).toBeLessThan(400)
    expect(page.nextOffset).toBe(page.page.length)
    const wire = JSON.stringify(toolSuccess({ rows: page.page }))
    expect(wire.length).toBeLessThanOrEqual(HARD_CAP_CHARS)
  })

  it("counts characters that JSON escapes", () => {
    const lines = Array.from({ length: 400 }, () => '"\\'.repeat(40))
    const page = fitPage(lines, {
      limit: 400,
      maxTokens: 100_000,
      result: (fitted) => ({ content: fitted.join("\n") }),
    })
    expect(page.truncated).toBe(true)
    expect(() => toolSuccess({ content: page.page.join("\n") })).not.toThrow()
  })

  it("cuts one item that cannot fit and says so", () => {
    const page = fitPage(["x".repeat(200_000), "next"], {
      limit: 10,
      maxTokens: 6_000,
      result: (fitted) => ({ content: fitted.join("\n") }),
    })
    expect(page.page).toHaveLength(1)
    expect(page.truncated).toBe(true)
    expect(page.cut).toBe(true)
    expect(page.nextOffset).toBe(1)
    expect(() => toolSuccess({ content: page.page[0] })).not.toThrow()
  })
})

describe("fitPage with an item that cannot be cut", () => {
  it("drops it, records it, and never returns an over-cap page", () => {
    const huge = {
      id: "huge",
      values: Array.from({ length: 200_000 }, () => 1),
    }
    const small = { id: "small", values: [1] }
    const result = (page: unknown[]) => ({ items: page })
    const first = fitPage([huge, small], {
      limit: 10,
      maxTokens: 4_000,
      result,
    })
    expect(first.page).toEqual([])
    expect(first.dropped).toEqual([huge])
    expect(first.truncated).toBe(true)
    expect(first.nextOffset).toBe(1)
    const fit = fitPage([huge, small], {
      offset: 1,
      limit: 10,
      maxTokens: 4_000,
      result,
    })
    expect(fit.page).toEqual([small])
    expect(fit.nextOffset).toBeNull()
    const alone = fitPage([huge], { limit: 10, maxTokens: 4_000, result })
    expect(alone.page).toEqual([])
    expect(() => toolSuccess(result(alone.page))).not.toThrow()
  })
})

describe("shrinkItem", () => {
  it("cuts the longest top-level string of an object", () => {
    const smaller = shrinkItem({ ref: "a.md", snippet: "z".repeat(100) })
    expect(smaller?.ref).toBe("a.md")
    expect(smaller?.snippet.length).toBe(50)
  })

  it("gives null when no string can shrink", () => {
    expect(shrinkItem({ path: "a", line: 3 })).toBeNull()
    expect(shrinkItem(42)).toBeNull()
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
