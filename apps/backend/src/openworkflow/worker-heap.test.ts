import { describe, expect, it } from "vitest"
import { workerHeapLimitMib, workerNodeOptions } from "./worker-heap.js"

const GiB = 1024 ** 3

describe("worker heap options", () => {
  it("caps the heap at 12 GiB on a 24 GB container", () => {
    expect(workerHeapLimitMib(24 * GiB)).toBe(12_288)
  })

  it("keeps the heap below the memory of a small container", () => {
    for (const mib of [1024, 2048, 4096]) {
      const heap = workerHeapLimitMib(mib * 1024 * 1024)
      expect(heap).toBeLessThan(mib * 0.6)
      expect(heap).toBeGreaterThan(mib * 0.5)
    }
  })

  it("adds the heap limit and the snapshot flags", () => {
    expect(workerNodeOptions(undefined, 4 * GiB)).toBe(
      "--max-old-space-size=2252 --heapsnapshot-near-heap-limit=1 --diagnostic-dir=/tmp/heap",
    )
  })

  it("keeps an operator value", () => {
    const options = workerNodeOptions(
      "--max-old-space-size=3000 --diagnostic-dir=/data",
      24 * GiB,
    )
    expect(options).toBe(
      "--max-old-space-size=3000 --diagnostic-dir=/data --heapsnapshot-near-heap-limit=1",
    )
  })
})
