import { afterEach, describe, expect, it, vi } from "vitest"
import { TtlCache } from "./ttl-cache.js"

describe("TtlCache", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns a value until its time to live ends", () => {
    vi.useFakeTimers()
    const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 10 })
    cache.set("a", "one")
    vi.advanceTimersByTime(999)
    expect(cache.get("a")).toBe("one")
    vi.advanceTimersByTime(1)
    expect(cache.get("a")).toBeUndefined()
  })

  it("drops the oldest entry when it holds more than maxEntries", () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 })
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toBe(2)
    expect(cache.get("c")).toBe(3)
  })

  it("keeps an entry that a read used last", () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 })
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)
    expect(cache.get("a")).toBe(1)
    expect(cache.get("b")).toBeUndefined()
  })

  it("does not extend the time to live on a read", () => {
    vi.useFakeTimers()
    const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 10 })
    cache.set("a", "one")
    vi.advanceTimersByTime(600)
    expect(cache.get("a")).toBe("one")
    vi.advanceTimersByTime(600)
    expect(cache.get("a")).toBeUndefined()
  })
})
