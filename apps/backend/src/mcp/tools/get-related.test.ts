import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  type RelevanceOptions,
  rankRelated,
} from "../../domain/workspaces/graph-relevance.js"
import { getRelatedInputShape } from "./get-related.js"

const schema = z.object(getRelatedInputShape)
const base = { workspace: "handbook", seeds: ["knowledge/a.md"] }

/** True when `rankRelated` accepts the option. */
function rankAccepts(options: RelevanceOptions): boolean {
  try {
    rankRelated({
      nodes: [{ id: "a", kind: null, degree: null }],
      signals: [],
      seeds: ["a"],
      options,
    })
    return true
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}

describe("get_related arguments", () => {
  it.each([
    ["restart", 0],
    ["restart", 1],
    ["restart", 1e-9],
    ["restart", 0.5],
    ["queryWeight", -0.01],
    ["queryWeight", 0],
    ["queryWeight", 1],
    ["queryWeight", 1.01],
    ["diversity", -0.01],
    ["diversity", 0],
    ["diversity", 1],
    ["diversity", 1.01],
    ["hubPenalty", -1],
    ["hubPenalty", 0],
    ["hubPenalty", 7],
    ["hubPenalty", Number.POSITIVE_INFINITY],
    ["recencyHalfLifeDays", 0],
    ["recencyHalfLifeDays", -1],
    ["recencyHalfLifeDays", 0.5],
  ] as const)("bounds %s = %s exactly as rankRelated does", (name, value) => {
    expect(schema.safeParse({ ...base, [name]: value }).success).toBe(
      rankAccepts({ [name]: value }),
    )
  })

  it("rejects a validity window that ends before it starts, as rankRelated does", () => {
    const window = {
      from: "2026-09-02T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    }
    expect(schema.safeParse({ ...base, validBetween: window }).success).toBe(
      false,
    )
    expect(
      rankAccepts({
        validBetween: { from: new Date(window.from), to: new Date(window.to) },
      }),
    ).toBe(false)
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
    expect(rejects({ maxFanOut: 0 })).toBe(false)
    expect(rejects({ maxFanOut: 1_001 })).toBe(false)
    expect(rejects({ minConfidence: 1.1 })).toBe(false)
    expect(rejects({ limit: 51 })).toBe(false)
    expect(rejects({ maxTokens: 499 })).toBe(false)
    expect(rejects({ maxTokens: 8_001 })).toBe(false)
    expect(rejects({ maxPerKind: 0 })).toBe(false)
    expect(rejects({ predicateWeights: { OWNS: -1 } })).toBe(false)
    expect(rejects({ intent: "authority" })).toBe(false)
    expect(
      rejects({ maxDepth: 4, maxFanOut: 1_000, limit: 50, maxTokens: 8_000 }),
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

  it("has one way to silence a predicate: a weight of 0", () => {
    expect(Object.keys(getRelatedInputShape)).not.toContain("excludePredicates")
    expect(
      schema.safeParse({ ...base, predicateWeights: { OWNS: 0 } }).success,
    ).toBe(true)
  })
})
