import { afterEach, describe, expect, it, vi } from "vitest"
import { getIndexerProcessConcurrency } from "./capacityEnv.js"
import {
  resetIndexerProcessSemaphoreForTests,
  withIndexerProcessSlot,
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
