import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../observability/logger.js", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { log } from "../observability/logger.js"
import {
  isTransientDbConnectionError,
  withTransientDbQueryRetry,
  wrapPoolQueryWithTransientRetry,
} from "./transientDbRetry.js"

describe("isTransientDbConnectionError", () => {
  it("matches Connection terminated unexpectedly", () => {
    expect(
      isTransientDbConnectionError(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBe(true)
  })

  it("matches errno codes", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    })
    expect(isTransientDbConnectionError(err)).toBe(true)
  })

  it("matches postgres SQLSTATE on nested cause", () => {
    const cause = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    })
    const err = new Error("Failed query: select 1", { cause })
    expect(isTransientDbConnectionError(err)).toBe(true)
  })

  it("rejects unrelated errors", () => {
    expect(isTransientDbConnectionError(new Error("unique violation"))).toBe(
      false,
    )
  })
})

describe("withTransientDbQueryRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("retries once on connection terminated then succeeds", async () => {
    let n = 0
    const result = await withTransientDbQueryRetry(
      async () => {
        n += 1
        if (n < 2) throw new Error("Connection terminated unexpectedly")
        return "ok"
      },
      { baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(n).toBe(2)
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "db.transient_connection_retry",
        attempt: 1,
        maxAttempts: 2,
        message: "Connection terminated unexpectedly",
      }),
    )
  })

  it("does not retry non-transient errors", async () => {
    let n = 0
    await expect(
      withTransientDbQueryRetry(async () => {
        n += 1
        throw new Error("unique violation")
      }),
    ).rejects.toThrow("unique violation")
    expect(n).toBe(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it("rethrows after exhausting retries", async () => {
    let n = 0
    await expect(
      withTransientDbQueryRetry(
        async () => {
          n += 1
          throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
        },
        { retries: 1, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "ECONNRESET" })
    expect(n).toBe(2)
  })
})

describe("wrapPoolQueryWithTransientRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("retries promise query once then succeeds", async () => {
    let n = 0
    const pool = {
      query: vi.fn(async () => {
        n += 1
        if (n < 2) throw new Error("Connection terminated unexpectedly")
        return { rows: [{ ok: true }] }
      }),
    }

    wrapPoolQueryWithTransientRetry(
      pool as unknown as import("pg").Pool,
    )

    const result = await (
      pool.query as unknown as () => Promise<{ rows: { ok: boolean }[] }>
    )()
    expect(result).toEqual({ rows: [{ ok: true }] })
    expect(n).toBe(2)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "db.transient_connection_retry" }),
    )
  })

  it("leaves callback-style query unwrapped for retry", () => {
    const underlying = vi.fn(
      (_sql: string, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("Connection terminated unexpectedly"))
      },
    )
    const pool = { query: underlying }

    wrapPoolQueryWithTransientRetry(
      pool as unknown as import("pg").Pool,
    )

    const cb = vi.fn()
    ;(pool.query as typeof underlying)("select 1", cb)
    expect(underlying).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })
})
