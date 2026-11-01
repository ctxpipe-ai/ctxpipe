import { describe, expect, it } from "vitest"

import { WorkflowLeaseLostError } from "./execution-lease.js"
import {
  cleanUpUnlessParked,
  isWorkflowControlSignal,
  settledChildren,
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

  it("keeps the resources of a failed execution while another execution has the run", async () => {
    const cleaned: string[] = []
    const refused = new Error("Failed to complete step attempt")
    await expect(
      cleanUpUnlessParked(
        async () => {
          throw refused
        },
        async () => {
          cleaned.push("tree")
        },
        { leaseState: async () => "taken" },
      ),
    ).rejects.toBe(refused)
    expect(cleaned).toEqual([])
  })

  it("cleans up after a failed execution when the run ended or the read fails", async () => {
    const cleaned: string[] = []
    for (const execution of [
      { leaseState: async () => "ended" as const },
      { leaseState: async () => "owned" as const },
      {
        leaseState: async (): Promise<"owned"> => {
          throw new Error("connect ECONNREFUSED")
        },
      },
    ])
      await expect(
        cleanUpUnlessParked(
          async () => {
            throw new WorkflowLeaseLostError("wr_1")
          },
          async () => {
            cleaned.push("tree")
          },
          execution,
        ),
      ).rejects.toThrow(WorkflowLeaseLostError)
    expect(cleaned).toEqual(["tree", "tree", "tree"])
  })
})

describe("settledChildren", () => {
  const ok = <T>(value: T): PromiseSettledResult<T> => ({
    status: "fulfilled",
    value,
  })
  const no = (reason: unknown): PromiseSettledResult<never> => ({
    status: "rejected",
    reason,
  })

  it("parks while a sibling still runs, also when another child failed", () => {
    const park = namedError("SleepSignalError")
    const failed = new Error("shard 0 failed")
    expect(() => settledChildren([no(failed), no(park), ok(1)])).toThrow(park)
  })

  it("fails with the first failure when every child has ended", () => {
    const failed = new Error("shard 0 failed")
    expect(() =>
      settledChildren([ok(1), no(failed), no(new Error("shard 2 failed"))]),
    ).toThrow(failed)
  })

  it("returns the values when every child is done", () => {
    expect(settledChildren([ok(1), ok(2)])).toEqual([1, 2])
  })
})
