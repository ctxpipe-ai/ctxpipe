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

  it("strips unsafe characters from object keys, last key winning a collision", () => {
    const spec: Record<string, number> = {}
    spec["a\u0000"] = 1
    spec.a = 2
    const sanitized = sanitizePostgresJson(spec)
    expect(sanitized).toEqual({ a: 2 })
    expect(JSON.stringify(sanitized)).not.toContain("\\u0000")
  })

  it("keeps a __proto__ key as its own property", () => {
    const spec = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>
    const sanitized = sanitizePostgresJson(spec)
    const parsed = JSON.parse(JSON.stringify(sanitized)) as object
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toEqual(
      { x: 1 },
    )
  })
})
