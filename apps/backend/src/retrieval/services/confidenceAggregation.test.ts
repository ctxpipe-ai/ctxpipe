import { describe, expect, it } from "vitest"
import { aggregateConfidence } from "./confidenceAggregation.js"

describe("aggregateConfidence", () => {
  it("returns 0 for empty evidence", () => {
    expect(aggregateConfidence([])).toBe(0)
  })

  it("aggregates single evidence", () => {
    const result = aggregateConfidence([
      {
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.8,
        observedAt: new Date(),
      },
    ])
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThanOrEqual(1)
  })

  it("weights by source and method", () => {
    const result = aggregateConfidence([
      {
        sourceType: "manual",
        extractionMethod: "manual",
        confidence: 0.9,
        observedAt: new Date(),
      },
      {
        sourceType: "slack",
        extractionMethod: "llm",
        confidence: 0.9,
        observedAt: new Date(),
      },
    ])
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThanOrEqual(1)
  })

  it("applies recency decay when halfLife > 0", () => {
    const ref = new Date("2026-06-01")
    const mixed = aggregateConfidence(
      [
        {
          sourceType: "git",
          extractionMethod: "deterministic",
          confidence: 1,
          observedAt: new Date("2024-01-01"),
        },
        {
          sourceType: "git",
          extractionMethod: "deterministic",
          confidence: 0.5,
          observedAt: new Date("2026-05-15"),
        },
      ],
      { referenceDate: ref, recencyHalfLifeDays: 90 },
    )
    expect(mixed).toBeGreaterThan(0)
    expect(mixed).toBeLessThanOrEqual(1)
    expect(mixed).toBeLessThan(0.75)
  })
})
