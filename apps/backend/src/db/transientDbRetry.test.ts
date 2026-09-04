import { beforeEach, describe, expect, it, vi } from "vitest"

const { poolConstructorMock } = vi.hoisted(() => ({
  poolConstructorMock: vi.fn(),
}))

vi.mock("pg", () => ({
  Pool: poolConstructorMock,
}))

vi.mock("../observability/logger.js", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { log } from "../observability/logger.js"
import {
  formatUnknownError,
  isDbConnectionAcquisitionError,
  isTransientDbConnectionError,
  waitForDbConnection,
  withDbConnectionAcquisitionRetry,
  wrapPoolQueryWithConnectionAcquisitionRetry,
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

  it("matches pg pool connect timeout message", () => {
    expect(
      isTransientDbConnectionError(
        new Error("timeout exceeded when trying to connect"),
      ),
    ).toBe(true)
  })

  it("matches AggregateError with nested ETIMEDOUT (empty top-level message)", () => {
    const nested = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    })
    const err = new AggregateError([nested, nested], "")
    expect(err.message).toBe("")
    expect(isTransientDbConnectionError(err)).toBe(true)
  })
})

describe("formatUnknownError", () => {
  it("surfaces nested AggregateError children when top-level message is empty", () => {
    const nested = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    })
    const err = new AggregateError([nested], "")
    expect(formatUnknownError(err)).toContain("connect ETIMEDOUT")
    expect(formatUnknownError(err)).toContain("ETIMEDOUT")
  })
})

describe("isDbConnectionAcquisitionError", () => {
  it("accepts only failures that happen before a query is sent", () => {
    expect(
      isDbConnectionAcquisitionError(
        new Error("timeout exceeded when trying to connect"),
      ),
    ).toBe(true)
    expect(
      isDbConnectionAcquisitionError(
        new AggregateError([
          Object.assign(new Error("connect ETIMEDOUT"), {
            code: "ETIMEDOUT",
            syscall: "connect",
          }),
        ]),
      ),
    ).toBe(true)
  })

  it("rejects ambiguous mid-query disconnects", () => {
    expect(
      isDbConnectionAcquisitionError(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBe(false)
    expect(
      isDbConnectionAcquisitionError(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
    ).toBe(false)
    expect(
      isDbConnectionAcquisitionError(
        Object.assign(new Error("timeout exceeded when trying to connect"), {
          code: "57P03",
          severity: "ERROR",
          routine: "exec_stmt_raise",
        }),
      ),
    ).toBe(false)
  })
})

describe("withDbConnectionAcquisitionRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("retries once when pool connection acquisition fails then succeeds", async () => {
    let n = 0
    const result = await withDbConnectionAcquisitionRetry(
      async () => {
        n += 1
        if (n < 2) throw new Error("timeout exceeded when trying to connect")
        return "ok"
      },
      { retries: 1, baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(n).toBe(2)
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "db.connection_acquisition_retry",
        attempt: 1,
        maxAttempts: 2,
        message: "timeout exceeded when trying to connect",
      }),
    )
  })

  it("defaults to one bounded retry", async () => {
    let n = 0
    const result = await withDbConnectionAcquisitionRetry(
      async () => {
        n += 1
        if (n < 2) throw new Error("timeout exceeded when trying to connect")
        return "ok"
      },
      { baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(n).toBe(2)
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it("does not retry ambiguous disconnects", async () => {
    let n = 0
    await expect(
      withDbConnectionAcquisitionRetry(async () => {
        n += 1
        throw new Error("Connection terminated unexpectedly")
      }),
    ).rejects.toThrow("Connection terminated unexpectedly")
    expect(n).toBe(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it("rethrows after exhausting retries", async () => {
    let n = 0
    await expect(
      withDbConnectionAcquisitionRetry(
        async () => {
          n += 1
          throw Object.assign(new Error("connect ETIMEDOUT"), {
            code: "ETIMEDOUT",
            syscall: "connect",
          })
        },
        { retries: 1, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(n).toBe(2)
  })

  it("caps startup-style exponential delays", async () => {
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("connect ETIMEDOUT"), {
        code: "ETIMEDOUT",
        syscall: "connect",
      }),
    )

    await expect(
      withDbConnectionAcquisitionRetry(run, {
        retries: 2,
        baseDelayMs: 10,
        maxDelayMs: 10,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ delayMs: 10 }),
    )
  })
})

describe("waitForDbConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    poolConstructorMock.mockReset()
  })

  it("reuses and closes one probe pool across acquisition retries", async () => {
    const release = vi.fn()
    const connect = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("connect ETIMEDOUT"), {
          code: "ETIMEDOUT",
          syscall: "connect",
        }),
      )
      .mockResolvedValueOnce({ release })
    const end = vi.fn().mockResolvedValue(undefined)
    poolConstructorMock.mockImplementation(function PoolMock() {
      return { connect, end }
    })

    await waitForDbConnection("postgresql://example", {
      retries: 1,
      baseDelayMs: 1,
    })

    expect(poolConstructorMock).toHaveBeenCalledTimes(1)
    expect(poolConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ max: 1, connectionTimeoutMillis: 5_000 }),
    )
    expect(connect).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it("closes the probe pool when acquisition fails permanently", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("password failed"))
    const end = vi.fn().mockResolvedValue(undefined)
    poolConstructorMock.mockImplementation(function PoolMock() {
      return { connect, end }
    })

    await expect(
      waitForDbConnection("postgresql://example", {
        retries: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow("password failed")

    expect(connect).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

describe("wrapPoolQueryWithConnectionAcquisitionRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("retries promise query once then succeeds", async () => {
    let n = 0
    const pool = {
      query: vi.fn(async () => {
        n += 1
        if (n < 2) throw new Error("timeout exceeded when trying to connect")
        return { rows: [{ ok: true }] }
      }),
    }

    wrapPoolQueryWithConnectionAcquisitionRetry(
      pool as unknown as import("pg").Pool,
    )

    const result = await (
      pool.query as unknown as (
        sql: string,
      ) => Promise<{ rows: { ok: boolean }[] }>
    )("select 1")
    expect(result).toEqual({ rows: [{ ok: true }] })
    expect(n).toBe(2)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "db.connection_acquisition_retry" }),
    )
  })

  it("leaves callback-style query unwrapped for retry", () => {
    const underlying = vi.fn(
      (_sql: string, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("Connection terminated unexpectedly"))
      },
    )
    const pool = { query: underlying }

    wrapPoolQueryWithConnectionAcquisitionRetry(
      pool as unknown as import("pg").Pool,
    )

    const cb = vi.fn()
    ;(pool.query as typeof underlying)("select 1", cb)
    expect(underlying).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it("does not retry writes after an ambiguous disconnect", async () => {
    const underlying = vi
      .fn()
      .mockRejectedValue(new Error("Connection terminated unexpectedly"))
    const pool = { query: underlying }

    wrapPoolQueryWithConnectionAcquisitionRetry(
      pool as unknown as import("pg").Pool,
    )

    await expect(
      (pool.query as unknown as (sql: string) => Promise<{ rows: unknown[] }>)(
        "insert into device_codes (id) values ('code_1')",
      ),
    ).rejects.toThrow("Connection terminated unexpectedly")
    expect(underlying).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it.each([
    "select nextval('device_codes_id_seq')",
    "select set_config('app.org_id', 'org_1', false)",
    "select pg_notify('events', 'payload')",
    "select pg_try_advisory_lock_shared(42)",
    "select * into temporary table copied_users from users",
    "select * from users for update",
  ])("does not retry side-effecting SELECT: %s", async (sql) => {
    const underlying = vi
      .fn()
      .mockRejectedValue(new Error("Connection terminated unexpectedly"))
    const pool = { query: underlying }

    wrapPoolQueryWithConnectionAcquisitionRetry(
      pool as unknown as import("pg").Pool,
    )

    await expect(
      (pool.query as unknown as (query: string) => Promise<unknown>)(sql),
    ).rejects.toThrow("Connection terminated unexpectedly")
    expect(underlying).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it("retries a write only when connection acquisition proves it was not sent", async () => {
    const underlying = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("timeout exceeded when trying to connect"),
      )
      .mockResolvedValueOnce({ rowCount: 1 })
    const pool = { query: underlying }

    wrapPoolQueryWithConnectionAcquisitionRetry(
      pool as unknown as import("pg").Pool,
    )

    await expect(
      (pool.query as unknown as (query: string) => Promise<unknown>)(
        "insert into device_codes (id) values ('code_1')",
      ),
    ).resolves.toEqual({ rowCount: 1 })
    expect(underlying).toHaveBeenCalledTimes(2)
  })
})
