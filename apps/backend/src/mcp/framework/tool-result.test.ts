import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it } from "vitest"
import { HARD_CAP_CHARS } from "./budget.js"
import { McpToolError } from "./tool-errors.js"
import { TOOL_ERROR_META_KEY, toolFailure, toolSuccess } from "./tool-result.js"

function responseChars(result: CallToolResult): number {
  return JSON.stringify({
    content: result.content,
    structuredContent: result.structuredContent,
  }).length
}

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

  it("refuses a result over the hard cap, counting structuredContent too, so the tool pages instead", () => {
    // About 12,000 characters of TOON and 14,000 of JSON: each alone is
    // under the cap, but the response is over it.
    const rows = Array.from({ length: 130 }, (_, index) => ({
      ref: `knowledge/${index}.md`,
      snippet: "y".repeat(80),
    }))
    expect(() => toolSuccess({ rows })).toThrowError(
      expect.objectContaining({ code: "response_too_large" }),
    )
    const result = toolSuccess({ rows: rows.slice(0, 60) })
    expect(responseChars(result)).toBeLessThanOrEqual(HARD_CAP_CHARS)
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
