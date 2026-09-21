import { describe, expect, it } from "vitest"
import { isValidPredicate, validatePredicate } from "./predicateValidation.js"

describe("predicateValidation", () => {
  it("accepts core predicates", () => {
    expect(isValidPredicate("DEPENDS_ON")).toBe(true)
    expect(isValidPredicate("EXPOSES_API")).toBe(true)
    expect(isValidPredicate("HAS_OPERATION")).toBe(true)
    expect(isValidPredicate("RUNS_ON")).toBe(true)
    validatePredicate("DEPENDS_ON")
  })

  it("accepts extension predicates", () => {
    expect(isValidPredicate("PART_OF")).toBe(true)
    expect(isValidPredicate("REFERENCES")).toBe(true)
    expect(isValidPredicate("DECLARED_IN")).toBe(true)
    validatePredicate("OWNS")
  })

  it("rejects retired predicates", () => {
    expect(isValidPredicate("ABOUT")).toBe(false)
    expect(isValidPredicate("RELATES_TO")).toBe(false)
  })

  it("accepts ingestion predicate contains", () => {
    expect(isValidPredicate("contains")).toBe(true)
    validatePredicate("contains")
  })

  it("rejects invalid predicates", () => {
    expect(isValidPredicate("INVALID")).toBe(false)
    expect(isValidPredicate("arbitrary")).toBe(false)
    expect(() => validatePredicate("INVALID")).toThrow(/Invalid predicate/)
  })
})
