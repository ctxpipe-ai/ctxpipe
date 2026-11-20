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
  TransientHttpError,
  withTransientHttpRetry,
} from "./withTransientHttpRetry.js"

describe("withTransientHttpRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("retries on TransientHttpError then succeeds", async () => {
    let n = 0
    const result = await withTransientHttpRetry(async () => {
      n += 1
      if (n < 2) throw new TransientHttpError("503", 503)
      return "ok"
    })
    expect(result).toBe("ok")
    expect(n).toBe(2)
  })

  it("retries on TypeError fetch failed then succeeds", async () => {
    let n = 0
    const result = await withTransientHttpRetry(
      async () => {
        n += 1
        if (n < 2) throw new TypeError("fetch failed")
        return "ok"
      },
      { retries: 2, baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(n).toBe(2)
  })

  it("logs nested cause and errno on fetch failed retries", async () => {
    const cause = new Error("read ECONNRESET") as NodeJS.ErrnoException
    cause.code = "ECONNRESET"
    let n = 0
    await withTransientHttpRetry(
      async () => {
        n += 1
        if (n < 2) throw new TypeError("fetch failed", { cause })
        return "ok"
      },
      { retries: 2, baseDelayMs: 1 },
    )
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "http.transient_retry",
        message: "fetch failed",
        errno: "ECONNRESET",
        cause: "read ECONNRESET",
      }),
    )
  })

  it("does not retry on AbortError", async () => {
    const err = new DOMException("aborted", "AbortError")
    await expect(
      withTransientHttpRetry(async () => {
        throw err
      }),
    ).rejects.toBe(err)
  })

  it("retries on ECONNREFUSED then succeeds", async () => {
    let n = 0
    const result = await withTransientHttpRetry(
      async () => {
        n += 1
        if (n < 2) {
          const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException
          err.code = "ECONNREFUSED"
          throw err
        }
        return "ok"
      },
      { retries: 2, baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(n).toBe(2)
  })

  it("retries an undici socket or connect timeout error under a non-fetch error", async () => {
    for (const code of ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]) {
      let n = 0
      const result = await withTransientHttpRetry(
        async () => {
          n += 1
          if (n < 2) {
            const cause = Object.assign(new Error("socket"), { code })
            throw new Error("request failed", { cause })
          }
          return "ok"
        },
        { retries: 2, baseDelayMs: 1 },
      )
      expect(result).toBe("ok")
      expect(n).toBe(2)
    }
  })

  describe("retryRestartsUntilAborted: a codesearch redeploy within the call's deadline", () => {
    const failing = (code: string, times: number) => {
      let n = 0
      const run = async () => {
        n += 1
        if (n <= times) {
          const err = new Error(`connect ${code}`) as NodeJS.ErrnoException
          err.code = code
          throw err
        }
        return "ok"
      }
      return { run, calls: () => n }
    }
    const opts = (signal?: AbortSignal) => ({
      retries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      signal,
      retryRestartsUntilAborted: true,
    })

    it("retries connection refused and name not found past `retries` while the signal holds", async () => {
      for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
        const restart = failing(code, 6)
        await expect(
          withTransientHttpRetry(
            restart.run,
            opts(new AbortController().signal),
          ),
        ).resolves.toBe("ok")
        expect(restart.calls(), code).toBe(7)
      }
    })

    it("keeps the short budget for every other failure, and without a signal", async () => {
      const reset = failing("ECONNRESET", 6)
      await expect(
        withTransientHttpRetry(reset.run, opts(new AbortController().signal)),
      ).rejects.toThrow(/ECONNRESET/)
      expect(reset.calls()).toBe(2)
      const unbounded = failing("ECONNREFUSED", 6)
      await expect(
        withTransientHttpRetry(unbounded.run, opts()),
      ).rejects.toThrow(/ECONNREFUSED/)
      expect(unbounded.calls()).toBe(2)
    })

    it("stops when the deadline aborts", async () => {
      const down = failing("ECONNREFUSED", Number.POSITIVE_INFINITY)
      await expect(
        withTransientHttpRetry(down.run, opts(AbortSignal.timeout(50))),
      ).rejects.toThrow()
      expect(down.calls()).toBeGreaterThan(2)
    })
  })

  it("retries on ECONNREFUSED via error.cause then succeeds", async () => {
    let n = 0
    const result = await withTransientHttpRetry(
      async () => {
        n += 1
        if (n < 2) {
          const cause = new Error(
            "connect ECONNREFUSED",
          ) as NodeJS.ErrnoException
          cause.code = "ECONNREFUSED"
          throw new Error("upstream unavailable", { cause })
        }
        return "ok"
      },
      { retries: 2, baseDelayMs: 1 },
    )
    expect(result).toBe("ok")
    expect(n).toBe(2)
  })

  it("retries when run returns a Response with status 503 then succeeds", async () => {
    let n = 0
    const result = await withTransientHttpRetry(
      async () => {
        n += 1
        if (n < 2) return new Response("unavailable", { status: 503 })
        return new Response("ok", { status: 200 })
      },
      { retries: 2, baseDelayMs: 1 },
    )
    expect(result.status).toBe(200)
    expect(n).toBe(2)
  })

  it("exhausts retries when Response stays 502", async () => {
    const run = vi.fn().mockResolvedValue(new Response("bad", { status: 502 }))
    await expect(
      withTransientHttpRetry(run, { retries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(TransientHttpError)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("does not retry non-gateway Response statuses", async () => {
    const result = await withTransientHttpRetry(
      async () => new Response("nope", { status: 404 }),
    )
    expect(result.status).toBe(404)
  })

  it("retries opaque 500 Internal Server Error then succeeds", async () => {
    let n = 0
    const result = await withTransientHttpRetry(
      async () => {
        n += 1
        if (n < 2) {
          return new Response("Internal Server Error", { status: 500 })
        }
        return new Response("ok", { status: 200 })
      },
      { retries: 2, baseDelayMs: 1 },
    )
    expect(result.status).toBe(200)
    expect(n).toBe(2)
  })

  it("does not retry JSON 500 bodies from the upstream handler", async () => {
    const result = await withTransientHttpRetry(
      async () =>
        new Response(JSON.stringify({ error: "Clone/checkout failed" }), {
          status: 500,
        }),
    )
    expect(result.status).toBe(500)
  })

  it("returns on the first successful attempt", async () => {
    const result = await withTransientHttpRetry(async () => "ok")
    expect(result).toBe("ok")
  })

  it("stops after exhausting retries on repeated 503", async () => {
    const run = vi.fn().mockImplementation(async () => {
      throw new TransientHttpError("503", 503)
    })
    await expect(
      withTransientHttpRetry(run, { retries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(TransientHttpError)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("exhausts retries: 10 (11 attempts) then throws", async () => {
    const run = vi.fn().mockImplementation(async () => {
      throw new TypeError("fetch failed")
    })
    await expect(
      withTransientHttpRetry(run, {
        retries: 10,
        baseDelayMs: 1,
        maxDelayMs: 1,
      }),
    ).rejects.toThrow(TypeError)
    expect(run).toHaveBeenCalledTimes(11)
  })

  it("caps delay with maxDelayMs", async () => {
    vi.useFakeTimers()
    const run = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok")

    const promise = withTransientHttpRetry(run, {
      retries: 10,
      baseDelayMs: 10_000,
      maxDelayMs: 50,
    })

    await vi.advanceTimersByTimeAsync(50)
    await expect(promise).resolves.toBe("ok")
  })
})
