import { describe, expect, it } from "vitest"
import { runWithConcurrency, SCIP_INDEXER_CONCURRENCY } from "./indexerPool.js"

describe("runWithConcurrency", () => {
  it("runs at most two workers in flight by default", async () => {
    let inFlight = 0
    let maxInFlight = 0

    const results = await runWithConcurrency(
      [30, 10, 20, 5, 15, 1],
      async (delayMs, index) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        expect(inFlight).toBeLessThanOrEqual(SCIP_INDEXER_CONCURRENCY)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        inFlight -= 1
        return index
      },
    )

    expect(SCIP_INDEXER_CONCURRENCY).toBe(2)
    expect(maxInFlight).toBe(2)
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("honors an explicit concurrency limit", async () => {
    let inFlight = 0
    let maxInFlight = 0

    await runWithConcurrency([1, 2, 3], 1, async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
    })

    expect(maxInFlight).toBe(1)
  })

  it("rejects invalid concurrency instead of deadlocking", async () => {
    await expect(
      runWithConcurrency([1], 0, async () => undefined),
    ).rejects.toThrow("concurrency must be a positive integer")
  })
})
