import { describe, expect, it } from "vitest"
import { withIndexConcurrency } from "./indexConcurrency.js"

describe("withIndexConcurrency", () => {
  it("runs one index pipeline at a time", async () => {
    let concurrent = 0
    let maxConcurrent = 0

    const task = async (delayMs: number) =>
      withIndexConcurrency(async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        concurrent -= 1
      })

    await Promise.all([task(30), task(30), task(30)])

    expect(maxConcurrent).toBe(1)
  })
})
