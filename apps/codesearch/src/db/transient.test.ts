import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
  attachPoolErrorListener,
  isTransientDbConnectionError,
  wrapPoolQueryWithTransientRetry,
} from "./transient.js"

describe("isTransientDbConnectionError", () => {
  it("matches Connection terminated unexpectedly", () => {
    expect(
      isTransientDbConnectionError(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBe(true)
  })

  it("matches drizzle Failed query wrapping a nested cause", () => {
    const cause = new Error("Connection terminated unexpectedly")
    expect(
      isTransientDbConnectionError(
        new Error("Failed query: select 1", { cause }),
      ),
    ).toBe(true)
  })

  it("rejects unrelated errors", () => {
    expect(isTransientDbConnectionError(new Error("unique violation"))).toBe(
      false,
    )
  })
})

describe("attachPoolErrorListener", () => {
  it("swallows pool error events so they are not uncaught", () => {
    const pool = new EventEmitter()
    attachPoolErrorListener(pool)
    expect(() =>
      pool.emit("error", new Error("Connection terminated unexpectedly")),
    ).not.toThrow()
  })
})

describe("wrapPoolQueryWithTransientRetry", () => {
  it("retries promise query once then succeeds", async () => {
    let n = 0
    const pool = {
      query: vi.fn(async () => {
        n += 1
        if (n < 2) throw new Error("Connection terminated unexpectedly")
        return { rows: [{ ok: true }] }
      }),
    }

    wrapPoolQueryWithTransientRetry(pool as unknown as import("pg").Pool)

    const result = await (
      pool.query as unknown as () => Promise<{ rows: { ok: boolean }[] }>
    )()
    expect(result).toEqual({ rows: [{ ok: true }] })
    expect(n).toBe(2)
  })
})
