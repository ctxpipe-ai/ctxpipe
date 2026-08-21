import { describe, expect, it } from "vitest"
import {
  assertSeededCanaryHidden,
  assertSeededCanaryVisible,
} from "./assert-rls-canary.js"

describe("seeded RLS canary assertions", () => {
  it("accepts SELECT/UPDATE 1 under GUC", () => {
    expect(() => assertSeededCanaryVisible(1, "SELECT")).not.toThrow()
    expect(() => assertSeededCanaryVisible(1, "UPDATE")).not.toThrow()
  })

  it("refuses empty-table counts as a canary", () => {
    expect(() => assertSeededCanaryVisible(0, "SELECT")).toThrow(
      /expected SELECT 1/,
    )
  })

  it("refuses SELECT/UPDATE without GUC when rows leak", () => {
    expect(() => assertSeededCanaryHidden(1, "SELECT")).toThrow(
      /expected SELECT 0 without GUC/,
    )
    expect(() => assertSeededCanaryHidden(1, "UPDATE")).toThrow(/BYPASSRLS/)
  })

  it("accepts hidden SELECT/UPDATE 0", () => {
    expect(() => assertSeededCanaryHidden(0, "SELECT")).not.toThrow()
    expect(() => assertSeededCanaryHidden(0, "UPDATE")).not.toThrow()
  })
})
