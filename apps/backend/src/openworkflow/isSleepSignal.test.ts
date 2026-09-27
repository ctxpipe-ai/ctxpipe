import { describe, expect, it } from "vitest"
import { isWorkflowControlSignal } from "./isSleepSignal.js"

function namedError(name: string, message = "park"): Error {
  const err = new Error(message)
  err.name = name
  return err
}

describe("isWorkflowControlSignal", () => {
  it("recognizes OpenWorkflow 0.8/0.9 SleepSignal", () => {
    expect(isWorkflowControlSignal(namedError("SleepSignal"))).toBe(true)
  })

  it("recognizes OpenWorkflow 0.10+ SleepSignalError", () => {
    expect(
      isWorkflowControlSignal(
        namedError("SleepSignalError", "SleepSignalError"),
      ),
    ).toBe(true)
  })

  it("recognizes a stale parallel execution branch", () => {
    expect(
      isWorkflowControlSignal(
        namedError(
          "StaleExecutionBranchError",
          "Workflow execution branch is no longer active",
        ),
      ),
    ).toBe(true)
  })

  it("rejects real errors and non-errors", () => {
    expect(isWorkflowControlSignal(new Error("child failed"))).toBe(false)
    expect(isWorkflowControlSignal(namedError("CancelSignal"))).toBe(false)
    expect(isWorkflowControlSignal("SleepSignalError")).toBe(false)
    expect(isWorkflowControlSignal(null)).toBe(false)
  })
})
