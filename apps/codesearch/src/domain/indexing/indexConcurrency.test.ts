import { describe, expect, it } from "vitest"
import {
  withIndexConcurrency,
  withRepositoryIndexOperation,
  withRepositoryPurgeOperation,
} from "./indexConcurrency.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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

describe("indexConcurrency repository operation exclusion", () => {
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

  it("allows same-repo index operations to overlap while purge waits", async () => {
    const events: string[] = []
    const releaseA = deferred()
    const releaseB = deferred()
    const startedA = deferred()
    const startedB = deferred()

    const indexA = withRepositoryIndexOperation("repo_same", async () => {
      events.push("index-a-start")
      startedA.resolve()
      await releaseA.promise
      events.push("index-a-end")
    })
    await startedA.promise

    const indexB = withRepositoryIndexOperation("repo_same", async () => {
      events.push("index-b-start")
      startedB.resolve()
      await releaseB.promise
      events.push("index-b-end")
    })
    await startedB.promise

    const purge = withRepositoryPurgeOperation("repo_same", async () => {
      events.push("purge")
    })
    await Promise.resolve()

    expect(events).toEqual(["index-a-start", "index-b-start"])

    releaseA.resolve()
    await indexA
    expect(events).not.toContain("purge")

    releaseB.resolve()
    await Promise.all([indexB, purge])

    expect(events).toEqual([
      "index-a-start",
      "index-b-start",
      "index-a-end",
      "index-b-end",
      "purge",
    ])
  })

  it("queues same-repo index operations behind an active purge", async () => {
    const events: string[] = []
    const releasePurge = deferred()
    const purgeStarted = deferred()

    const purge = withRepositoryPurgeOperation("repo_purging", async () => {
      events.push("purge-start")
      purgeStarted.resolve()
      await releasePurge.promise
      events.push("purge-end")
    })
    await purgeStarted.promise

    const index = withRepositoryIndexOperation("repo_purging", async () => {
      events.push("index")
    })
    await Promise.resolve()

    expect(events).toEqual(["purge-start"])

    releasePurge.resolve()
    await Promise.all([purge, index])

    expect(events).toEqual(["purge-start", "purge-end", "index"])
  })
})
