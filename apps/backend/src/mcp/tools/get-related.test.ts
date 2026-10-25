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
    ["hubPenalty", 1],
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
    expect(rejects({ maxFanOut: 4 })).toBe(false)
    expect(rejects({ maxFanOut: 201 })).toBe(false)
    // The tool allows less than rankRelated: a hub penalty above 1 hides
    // every hub.
    expect(rejects({ hubPenalty: 1.01 })).toBe(false)
    expect(rankAccepts({ hubPenalty: 7 })).toBe(true)
    expect(rejects({ minConfidence: 1.1 })).toBe(false)
    expect(rejects({ limit: 51 })).toBe(false)
    expect(rejects({ maxTokens: 499 })).toBe(false)
    expect(rejects({ maxTokens: 8_001 })).toBe(false)
    expect(rejects({ maxPerKind: 0 })).toBe(false)
    expect(rejects({ predicateWeights: { OWNS: -1 } })).toBe(false)
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

  it("excludes predicates from the walk and kinds from the results", () => {
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
    const nodes = [
      { id: "a", kind: "Service", degree: 2 },
      { id: "b", kind: "Thread", degree: 1 },
      { id: "c", kind: "Team", degree: 1 },
    ]
    const signal = (id: string, targetId: string) => ({
      id,
      sourceId: "a",
      targetId,
      predicate: "RELATES_TO",
      confidence: 1,
      validFrom: null,
      validTo: null,
      source: null,
      lastObservedAt: null,
    })
    const ranked = rankRelated({
      nodes,
      signals: [signal("e1", "b"), signal("e2", "c")],
      seeds: ["a"],
      options: { excludeKinds: ["thread"] },
    })
    expect(ranked.map((result) => result.id)).toEqual(["c"])
  })
})
