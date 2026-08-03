import { describe, expect, it } from "vitest"
import {
  beginIndexLease,
  endIndexLease,
  withIndexConcurrency,
} from "./indexConcurrency.js"

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

describe("indexConcurrency leases", () => {
  it("begin/end is idempotent for the same leaseId", async () => {
    const { leaseId } = await beginIndexLease()
    await endIndexLease(leaseId)
    await endIndexLease(leaseId)
    const second = await beginIndexLease()
    await endIndexLease(second.leaseId)
  })

  it("withIndexConcurrency serializes overlapping work", async () => {
    const order: string[] = []
    const a = withIndexConcurrency(async () => {
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 20))
      order.push("a-end")
    })
    const b = withIndexConcurrency(async () => {
      order.push("b-start")
      order.push("b-end")
    })
    await Promise.all([a, b])
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })
})
