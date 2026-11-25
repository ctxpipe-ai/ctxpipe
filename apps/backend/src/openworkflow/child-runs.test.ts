import { describe, expect, it } from "vitest"

import { settledChildren, windowedChildren } from "./child-runs.js"

function namedError(name: string, message = "park"): Error {
  const err = new Error(message)
  err.name = name
  return err
}

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

describe("windowedChildren", () => {
  /**
   * The children of a parent run as OpenWorkflow keeps them: a started child
   * runs until the test ends it. `start(n)` gives the value of a done child,
   * throws the error of a failed child, and parks for a child that runs, as
   * `step.runWorkflow` does in one execution.
   */
  function children() {
    const state = new Map<number, "running" | "done" | "failed">()
    const park = namedError("SleepSignalError")
    const started: number[][] = []
    return {
      park,
      end: (n: number, to: "done" | "failed") => state.set(n, to),
      started,
      /** One execution of the parent. */
      execute: (count: number, size: number) => {
        const execution: number[] = []
        started.push(execution)
        return windowedChildren(count, size, (n) => {
          execution.push(n)
          const now = state.get(n) ?? "running"
          state.set(n, now)
          if (now === "done") return Promise.resolve(n)
          if (now === "failed")
            return Promise.reject(new Error(`shard ${n} failed`))
          return Promise.reject(park)
        })
      },
    }
  }

  it("starts a new child when a child ends, and a slow child does not stop the next ones", async () => {
    const run = children()
    await expect(run.execute(6, 3)).rejects.toBe(run.park)
    expect(run.started.at(-1)).toEqual([0, 1, 2])
    // Child 0 is slow. Child 1 ends, so child 3 starts.
    run.end(1, "done")
    await expect(run.execute(6, 3)).rejects.toBe(run.park)
    expect(run.started.at(-1)).toEqual([0, 1, 2, 3])
    run.end(2, "done")
    run.end(3, "done")
    await expect(run.execute(6, 3)).rejects.toBe(run.park)
    expect(run.started.at(-1)).toEqual([0, 1, 2, 3, 4, 5])
    for (const n of [0, 4, 5]) run.end(n, "done")
    await expect(run.execute(6, 3)).resolves.toEqual([0, 1, 2, 3, 4, 5])
  })

  it("asks each child again at a replay that it started before", async () => {
    const run = children()
    await expect(run.execute(5, 2)).rejects.toBe(run.park)
    run.end(0, "done")
    await expect(run.execute(5, 2)).rejects.toBe(run.park)
    // A replay with no change asks the same children.
    await expect(run.execute(5, 2)).rejects.toBe(run.park)
    expect(run.started.slice(1)).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ])
  })

  it("keeps a failed child in the window, and fails only when each started child has ended", async () => {
    const run = children()
    await expect(run.execute(5, 2)).rejects.toBe(run.park)
    run.end(0, "failed")
    // Child 1 still runs: the run parks, and it starts no child in the
    // place of the failed one.
    await expect(run.execute(5, 2)).rejects.toBe(run.park)
    expect(run.started.at(-1)).toEqual([0, 1])
    run.end(1, "done")
    await expect(run.execute(5, 2)).rejects.toBe(run.park)
    expect(run.started.at(-1)).toEqual([0, 1, 2])
    run.end(2, "failed")
    await expect(run.execute(5, 2)).rejects.toThrow("shard 0 failed")
    expect(run.started.at(-1)).toEqual([0, 1, 2])
  })
})
