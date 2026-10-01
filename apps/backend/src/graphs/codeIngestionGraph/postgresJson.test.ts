import { describe, expect, it } from "vitest"
import { sanitizePostgresJson } from "./postgresJson.js"

describe("sanitizePostgresJson", () => {
  it("drops null bytes and unpaired surrogates that Postgres jsonb rejects", () => {
    const lone = "x\uD800y"
    const sanitized = sanitizePostgresJson({
      name: "a\u0000b",
      note: lone,
      ok: "héllo 👍",
      nested: [{ text: "c\u0000" }],
    })
    expect(sanitized).toEqual({
      name: "ab",
      note: "xy",
      ok: "héllo 👍",
      nested: [{ text: "c" }],
    })
    expect(JSON.stringify(sanitized)).not.toContain("\\u0000")
    expect(JSON.stringify(sanitized)).not.toContain("\\ud800")
  })
})
