import { describe, expect, it } from "vitest"
import { z } from "zod"

import { getRelatedInputShape } from "./get-related.js"

const schema = z.object(getRelatedInputShape)
const base = { workspace: "handbook", seeds: ["knowledge/a.md"] }

describe("get_related arguments", () => {
  it("rejects a validity window that ends before it starts", () => {
    const window = {
      from: "2026-09-02T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    }
    expect(schema.safeParse({ ...base, validBetween: window }).success).toBe(
      false,
    )
    expect(
      schema.safeParse({
        ...base,
        validBetween: { from: window.to, to: window.from },
      }).success,
    ).toBe(true)
  })

  it("bounds the expansion and the page as the design says", () => {
    const rejects = (extra: Record<string, unknown>) =>
      schema.safeParse({ ...base, ...extra }).success
    expect(rejects({ seeds: [] })).toBe(false)
    expect(
      rejects({ seeds: Array.from({ length: 11 }, (_, i) => `u${i}`) }),
    ).toBe(false)
    expect(rejects({ maxDepth: 0 })).toBe(false)
    expect(rejects({ maxDepth: 5 })).toBe(false)
    expect(rejects({ maxFanOut: 4 })).toBe(false)
    expect(rejects({ maxFanOut: 201 })).toBe(false)
    expect(rejects({ minConfidence: 1.1 })).toBe(false)
    expect(rejects({ limit: 51 })).toBe(false)
    expect(rejects({ maxTokens: 499 })).toBe(false)
    expect(rejects({ maxTokens: 8_001 })).toBe(false)
    expect(rejects({ intent: "authority" })).toBe(false)
    expect(
      rejects({ maxDepth: 4, maxFanOut: 200, limit: 50, maxTokens: 8_000 }),
    ).toBe(true)
  })

  it("applies the documented defaults", () => {
    expect(schema.parse(base)).toMatchObject({
      intent: "general",
      direction: "both",
      maxDepth: 2,
      maxFanOut: 50,
      minConfidence: 0.2,
      explain: true,
      includeSeeds: false,
      limit: 10,
      maxTokens: 3_000,
    })
  })

  it("has no authority option", () => {
    expect(Object.keys(getRelatedInputShape)).not.toContain("authority")
  })

  it("accepts predicates to exclude from the walk and kinds to exclude from the results", () => {
    expect(
      schema.parse({
        ...base,
        excludePredicates: ["mentions"],
        excludeKinds: ["Thread"],
      }),
    ).toMatchObject({
      excludePredicates: ["mentions"],
      excludeKinds: ["Thread"],
    })
    expect(schema.safeParse({ ...base, excludePredicates: [] }).success).toBe(
      false,
    )
  })
})
