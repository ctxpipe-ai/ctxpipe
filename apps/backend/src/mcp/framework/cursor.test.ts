import { describe, expect, it } from "vitest"
import { decodeCursor, encodeCursor } from "./cursor.js"

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
