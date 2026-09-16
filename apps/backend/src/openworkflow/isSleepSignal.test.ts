import { describe, expect, it } from "vitest"
import { isSleepSignal } from "./isSleepSignal.js"

function namedError(name: string, message = "park"): Error {
  const err = new Error(message)
  err.name = name
  return err
}

describe("isSleepSignal", () => {
  it("recognizes OpenWorkflow 0.8/0.9 SleepSignal", () => {
    expect(isSleepSignal(namedError("SleepSignal"))).toBe(true)
  })

  it("recognizes OpenWorkflow 0.10+ SleepSignalError", () => {
    expect(isSleepSignal(namedError("SleepSignalError", "SleepSignalError"))).toBe(
      true,
    )
  })

  it("rejects real errors and non-errors", () => {
    expect(isSleepSignal(new Error("child failed"))).toBe(false)
    expect(isSleepSignal(namedError("CancelSignal"))).toBe(false)
    expect(isSleepSignal("SleepSignalError")).toBe(false)
    expect(isSleepSignal(null)).toBe(false)
  })
})
