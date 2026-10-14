import { describe, expect, it } from "vitest"
import {
  cleanUpUnlessParked,
  isWorkflowControlSignal,
} from "./isSleepSignal.js"

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

describe("cleanUpUnlessParked", () => {
  it("cleans up after a run that returns", async () => {
    const cleaned: string[] = []
    await expect(
      cleanUpUnlessParked(
        async () => "done",
        async () => {
          cleaned.push("tree")
        },
      ),
    ).resolves.toBe("done")
    expect(cleaned).toEqual(["tree"])
  })

  it("cleans up after a run that fails and rethrows the failure", async () => {
    const cleaned: string[] = []
    await expect(
      cleanUpUnlessParked(
        async () => {
          throw new Error("assemble failed")
        },
        async () => {
          cleaned.push("tree")
        },
      ),
    ).rejects.toThrow("assemble failed")
    expect(cleaned).toEqual(["tree"])
  })

  it("keeps the resources of a run that parks to wait for a child", async () => {
    const cleaned: string[] = []
    const park = namedError("SleepSignalError")
    await expect(
      cleanUpUnlessParked(
        async () => {
          throw park
        },
        async () => {
          cleaned.push("tree")
        },
      ),
    ).rejects.toBe(park)
    expect(cleaned).toEqual([])
  })
})
