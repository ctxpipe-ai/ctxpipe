import { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import {
  buildPgPoolConfig,
  isTransientPgConnectionError,
  RetryingPgPool,
} from "./pg-pool.js"

describe("buildPgPoolConfig", () => {
  it("sets keepalive, idle timeout, maxUses, and strips sslmode from URL", () => {
    const config = buildPgPoolConfig({
      connectionString:
        "postgresql://user:pass@db.example.com:5432/ctxpipe?sslmode=require",
      applicationName: "ctxpipe-test",
    })

    expect(config.keepAlive).toBe(true)
    expect(config.idleTimeoutMillis).toBe(30_000)
    expect(config.maxUses).toBe(5_000)
    expect(config.application_name).toBe("ctxpipe-test")
    expect(config.connectionString).not.toContain("sslmode=")
    expect(config.ssl).toEqual({ rejectUnauthorized: false })
  })

  it("leaves local URLs without sslmode unchanged", () => {
    const config = buildPgPoolConfig({
      connectionString: "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe",
    })
    expect(config.ssl).toBeUndefined()
    expect(config.connectionString).toBe(
      "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe",
    )
  })

  it("maps verify-full to strict TLS", () => {
    const config = buildPgPoolConfig({
      connectionString:
        "postgresql://u:p@host/db?sslmode=verify-full",
    })
    expect(config.ssl).toEqual({ rejectUnauthorized: true })
  })
})

describe("isTransientPgConnectionError", () => {
  it("detects connection terminated unexpectedly", () => {
    expect(
      isTransientPgConnectionError(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBe(true)
  })

  it("ignores unrelated errors", () => {
    expect(isTransientPgConnectionError(new Error("syntax error"))).toBe(false)
  })
})

describe("RetryingPgPool", () => {
  it("retries once on transient connection errors", async () => {
    const spy = vi
      .spyOn(Pool.prototype, "query")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const pool = new RetryingPgPool({
      connectionString: "postgresql://u:p@localhost:5433/ctxpipe",
    })
    await pool.query("select 1")
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
    await pool.end()
  })
})
