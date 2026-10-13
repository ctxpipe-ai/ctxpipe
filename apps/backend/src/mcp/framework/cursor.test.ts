import { describe, expect, it } from "vitest"
import { decodeCursor, encodeCursor } from "./cursor.js"

const sha = "4f2c1e9a0b"

describe("cursor", () => {
  it("round-trips the offset for the same SHA and scope", () => {
    const cursor = encodeCursor({
      sha,
      scope: "search_knowledge:q1",
      offset: 20,
    })
    expect(decodeCursor(cursor, { sha, scope: "search_knowledge:q1" })).toBe(20)
  })

  it("is opaque: no SHA or scope in clear text", () => {
    const cursor = encodeCursor({
      sha,
      scope: "search_knowledge:q1",
      offset: 20,
    })
    expect(cursor).not.toContain(sha)
    expect(cursor).not.toContain("search_knowledge")
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("gives stale_cursor when the projection SHA changed", () => {
    const cursor = encodeCursor({ sha, scope: "s", offset: 10 })
    expect(() =>
      decodeCursor(cursor, { sha: "91ab0d2", scope: "s" }),
    ).toThrowError(
      expect.objectContaining({ code: "stale_cursor", retryable: false }),
    )
  })

  it("gives invalid_cursor for a cursor of another query", () => {
    const cursor = encodeCursor({
      sha,
      scope: "search_knowledge:q1",
      offset: 10,
    })
    expect(() =>
      decodeCursor(cursor, { sha, scope: "search_knowledge:q2" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_cursor" }))
  })

  it.each([
    "",
    "not-base64!",
    "e30",
    Buffer.from('{"v":1,"o":-1}').toString("base64url"),
  ])("gives invalid_cursor for %j", (cursor) => {
    expect(() => decodeCursor(cursor, { sha, scope: "s" })).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    )
  })
})
