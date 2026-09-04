import { describe, expect, it, vi } from "vitest"
import {
  waitUntilZoektReposLoaded,
  ZOEKT_WARMUP_MAX_TIMEOUT_MS,
  ZOEKT_WARMUP_TIMEOUT_MS,
  ZoektWarmupTimeoutError,
  zoektWarmupTimeoutMs,
} from "./warmup.js"

describe("zoektWarmupTimeoutMs", () => {
  it("keeps the baseline for a single shard", () => {
    expect(zoektWarmupTimeoutMs([{ shardCount: 1 }])).toBe(
      ZOEKT_WARMUP_TIMEOUT_MS,
    )
  })

  it("scales with the number of cold shards", () => {
    expect(zoektWarmupTimeoutMs([{ shardCount: 4 }, { shardCount: 3 }])).toBe(
      ZOEKT_WARMUP_TIMEOUT_MS + 6_000,
    )
  })

  it("caps large organisation-wide warmups", () => {
    expect(zoektWarmupTimeoutMs([{ shardCount: 100 }])).toBe(
      ZOEKT_WARMUP_MAX_TIMEOUT_MS,
    )
  })
})

describe("waitUntilZoektReposLoaded", () => {
  it("resolves once /api/list includes every expected repo id", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ List: { Repos: [] } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            List: { Repos: [{ Repository: { ID: 1 } }] },
          }),
          { status: 200 },
        ),
      )
    const sleepFn = vi.fn(async () => {})

    await waitUntilZoektReposLoaded({
      repoIds: [1],
      baseUrl: "http://zoekt.test",
      fetchFn,
      sleepFn,
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalled()
  })

  it("retries while Zoekt is unavailable then succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            List: { Repos: [{ Repository: { ID: 7 } }] },
          }),
          { status: 200 },
        ),
      )

    await waitUntilZoektReposLoaded({
      repoIds: [7],
      baseUrl: "http://zoekt.test",
      fetchFn,
      sleepFn: async () => {},
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    })

    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("times out when repos never appear", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ List: { Repos: [] } }), { status: 200 }),
      )

    await expect(
      waitUntilZoektReposLoaded({
        repoIds: [1, 2],
        baseUrl: "http://zoekt.test",
        fetchFn,
        sleepFn: async () => {},
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(ZoektWarmupTimeoutError)
  })

  it("no-ops when there are no repo ids to wait for", async () => {
    const fetchFn = vi.fn()
    await waitUntilZoektReposLoaded({
      repoIds: [],
      fetchFn,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
