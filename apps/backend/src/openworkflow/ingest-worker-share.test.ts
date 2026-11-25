import { describe, expect, it } from "vitest"

import {
  ingestWorkerShare,
  withIngestWorkerShare,
} from "./ingest-worker-share.js"

/**
 * A `step` of one execution, as OpenWorkflow gives it: a sleep that has not
 * ended parks the execution (it throws), and a finished sleep returns.
 */
function execution(finished: readonly string[] = []) {
  const sleeps: string[] = []
  const park = new Error("park")
  park.name = "SleepSignalError"
  return {
    park,
    sleeps,
    step: {
      sleep(name: string, duration: string) {
        sleeps.push(`${name} ${duration}`)
        return finished.includes(name)
          ? Promise.resolve()
          : Promise.reject(park)
      },
    },
  }
}

describe("ingestWorkerShare", () => {
  it("is half of the worker concurrency of the process, and at least 1", () => {
    expect(ingestWorkerShare({ OPENWORKFLOW_CONCURRENCY: "16" })).toBe(8)
    expect(ingestWorkerShare({ OPENWORKFLOW_CONCURRENCY: "5" })).toBe(2)
    expect(ingestWorkerShare({ OPENWORKFLOW_CONCURRENCY: "2" })).toBe(1)
    // The default concurrency (ADR-027) is 4.
    expect(ingestWorkerShare({})).toBe(2)
  })
})

describe("withIngestWorkerShare", () => {
  it("parks a shard while the share is full, and runs it when a shard ends", async () => {
    let end = () => {}
    const first = withIngestWorkerShare(
      execution().step,
      () => new Promise<string>((resolve) => (end = () => resolve("first"))),
      1,
    )
    // The share is full: the next shard parks before it does any work.
    const waiting = execution()
    let ran = false
    await expect(
      withIngestWorkerShare(
        waiting.step,
        async () => {
          ran = true
          return "second"
        },
        1,
      ),
    ).rejects.toBe(waiting.park)
    expect(ran).toBe(false)
    expect(waiting.sleeps).toEqual(["await-worker-share:0 15 seconds"])

    end()
    await expect(first).resolves.toBe("first")
    // The replay after the wait finds its finished sleep, and the shard runs.
    await expect(
      withIngestWorkerShare(
        execution(["await-worker-share:0"]).step,
        async () => "second",
        1,
      ),
    ).resolves.toBe("second")
  })

  it("frees its place when the shard parks or fails, and waits longer after each wait", async () => {
    const parked = new Error("park")
    parked.name = "SleepSignalError"
    await expect(
      withIngestWorkerShare(execution().step, () => Promise.reject(parked), 1),
    ).rejects.toBe(parked)
    await expect(
      withIngestWorkerShare(
        execution().step,
        () => Promise.reject(new Error("failed")),
        1,
      ),
    ).rejects.toThrow("failed")
    await expect(
      withIngestWorkerShare(execution().step, async () => "free", 1),
    ).resolves.toBe("free")

    let end = () => {}
    const holder = withIngestWorkerShare(
      execution().step,
      () => new Promise<void>((resolve) => (end = resolve)),
      1,
    )
    const waits = Array.from({ length: 7 }, (_, i) => `await-worker-share:${i}`)
    const replay = execution(waits.slice(0, 6))
    await expect(
      withIngestWorkerShare(replay.step, async () => undefined, 1),
    ).rejects.toBe(replay.park)
    expect(replay.sleeps).toEqual([
      "await-worker-share:0 15 seconds",
      "await-worker-share:1 30 seconds",
      "await-worker-share:2 60 seconds",
      "await-worker-share:3 120 seconds",
      "await-worker-share:4 240 seconds",
      "await-worker-share:5 300 seconds",
      "await-worker-share:6 300 seconds",
    ])
    end()
    await holder
  })
})
