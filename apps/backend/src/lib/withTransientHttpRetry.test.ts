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
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "http.transient_retry",
        attempt: 1,
        maxAttempts: 3,
        message: "503",
      }),
    )
    expect(log.error).not.toHaveBeenCalled()
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
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
  })

  it("does not retry on AbortError", async () => {
    const err = new DOMException("aborted", "AbortError")
    await expect(
      withTransientHttpRetry(async () => {
        throw err
      }),
    ).rejects.toBe(err)
    expect(log.info).not.toHaveBeenCalled()
  })

  it("does not log info when the first attempt succeeds", async () => {
    const result = await withTransientHttpRetry(async () => "ok")
    expect(result).toBe("ok")
    expect(log.info).not.toHaveBeenCalled()
  })

  it("stops after exhausting retries on repeated 503", async () => {
    const run = vi.fn().mockImplementation(async () => {
      throw new TransientHttpError("503", 503)
    })
    await expect(
      withTransientHttpRetry(run, { retries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(TransientHttpError)
    expect(run).toHaveBeenCalledTimes(3)
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.error).not.toHaveBeenCalled()
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
    expect(log.info).toHaveBeenCalledTimes(10)
    expect(log.error).not.toHaveBeenCalled()
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
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "http.transient_retry",
        delayMs: 50,
      }),
    )
  })
})
