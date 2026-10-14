import { describe, expect, it } from "vitest"
import { decodeCursor, decodeCursorWithAnchor, encodeCursor } from "./cursor.js"

const bound = {
  orgId: "org_a",
  workspaceId: "ws_a",
  sha: "4f2c1e9a0b",
  scope: "search_knowledge:q1",
}

describe("cursor", () => {
  it("round-trips the offset for the same org, Workspace, SHA and scope", () => {
    const cursor = encodeCursor({ ...bound, offset: 20 })
    expect(decodeCursor(cursor, bound)).toBe(20)
  })

  it("round-trips the anchor time and omits it when none is set", () => {
    const anchored = encodeCursor({
      ...bound,
      offset: 5,
      anchor: 1_760_000_000_000,
    })
    expect(decodeCursorWithAnchor(anchored, bound)).toEqual({
      offset: 5,
      anchor: 1_760_000_000_000,
    })
    expect(
      decodeCursorWithAnchor(encodeCursor({ ...bound, offset: 5 }), bound),
    ).toEqual({ offset: 5, anchor: undefined })
  })

  it("gives invalid_cursor for an anchor that is not a number", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, s: "x", q: "y", o: 1, t: "now" }),
    ).toString("base64url")
    expect(() => decodeCursorWithAnchor(forged, bound)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    )
  })

  it("gives invalid_cursor for an anchor outside the date range", () => {
    const valid = encodeCursor({ ...bound, offset: 1, anchor: 1 })
    const payload = JSON.parse(Buffer.from(valid, "base64url").toString("utf8"))
    const forged = Buffer.from(
      JSON.stringify({ ...payload, t: 9e15 }),
    ).toString("base64url")
    expect(() => decodeCursorWithAnchor(forged, bound)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    )
  })

  it("is opaque: no id, SHA or scope in clear text", () => {
    const cursor = encodeCursor({ ...bound, offset: 20 })
    for (const value of ["org_a", "ws_a", bound.sha, "search_knowledge"]) {
      expect(cursor).not.toContain(value)
    }
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("gives stale_cursor when the projection SHA changed", () => {
    const cursor = encodeCursor({ ...bound, offset: 10 })
    expect(() =>
      decodeCursor(cursor, { ...bound, sha: "91ab0d2" }),
    ).toThrowError(
      expect.objectContaining({ code: "stale_cursor", retryable: false }),
    )
  })

  it.each([
    ["another org", { orgId: "org_b" }],
    ["another Workspace", { workspaceId: "ws_b" }],
    ["no Workspace", { workspaceId: null }],
    ["another query", { scope: "search_knowledge:q2" }],
  ])("gives invalid_cursor for a cursor of %s", (_case, change) => {
    const cursor = encodeCursor({ ...bound, offset: 10 })
    expect(() => decodeCursor(cursor, { ...bound, ...change })).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    )
  })

  it.each([
    "",
    "not-base64!",
    "e30",
    Buffer.from('{"v":1,"o":-1}').toString("base64url"),
  ])("gives invalid_cursor for %j", (cursor) => {
    expect(() => decodeCursor(cursor, bound)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    )
  })
})
