import { afterEach, describe, expect, it, vi } from "vitest"

import { getIndexerProcessConcurrency } from "./capacityEnv.js"
import {
  resetIndexerProcessSemaphoreForTests,
  withIndexerProcessSlot,
  withScipIndexerSlot,
} from "./indexerProcessSemaphore.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("indexer process semaphore", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetIndexerProcessSemaphoreForTests()
  })

  it("limits concurrent spawns to CODESEARCH_INDEXER_CONCURRENCY", async () => {
    vi.stubEnv("CODESEARCH_INDEXER_CONCURRENCY", "1")
    expect(getIndexerProcessConcurrency()).toBe(1)

    let concurrent = 0
    let maxConcurrent = 0
    const first = deferred()
    const startedSecond = deferred()

    const a = withIndexerProcessSlot(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await first.promise
      concurrent -= 1
    })

    const b = withIndexerProcessSlot(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      startedSecond.resolve()
      concurrent -= 1
    })

    await Promise.resolve()
    expect(maxConcurrent).toBe(1)
    first.resolve()
    await Promise.all([a, b, startedSecond.promise])
    expect(maxConcurrent).toBe(1)
  })
})

describe("SCIP indexer slot", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetIndexerProcessSemaphoreForTests()
  })

  it("runs one SCIP indexer at a time and keeps a process slot for Zoekt", async () => {
    vi.stubEnv("CODESEARCH_INDEXER_CONCURRENCY", "2")
    const firstScip = deferred()
    const started: string[] = []

    const a = withScipIndexerSlot(async () => {
      started.push("scip-a")
      await firstScip.promise
    })
    const b = withScipIndexerSlot(async () => {
      started.push("scip-b")
    })
    await vi.waitFor(() => expect(started).toEqual(["scip-a"]))

    await withIndexerProcessSlot(async () => {
      started.push("zoekt")
    })
    expect(started).toEqual(["scip-a", "zoekt"])

    firstScip.resolve()
    await Promise.all([a, b])
    expect(started).toEqual(["scip-a", "zoekt", "scip-b"])
  })
})
