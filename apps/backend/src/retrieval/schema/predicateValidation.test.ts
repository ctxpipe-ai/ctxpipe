import { describe, expect, it } from "vitest"
import { isValidPredicate, validatePredicate } from "./predicateValidation.js"

describe("predicateValidation", () => {
  it("accepts core predicates", () => {
    expect(isValidPredicate("DEPENDS_ON")).toBe(true)
    expect(isValidPredicate("EXPOSES_API")).toBe(true)
    expect(isValidPredicate("RUNS_ON")).toBe(true)
    validatePredicate("DEPENDS_ON")
  })

  it("accepts extension predicates", () => {
    expect(isValidPredicate("RELATES_TO")).toBe(true)
    expect(isValidPredicate("ABOUT")).toBe(true)
    validatePredicate("RELATES_TO")
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
