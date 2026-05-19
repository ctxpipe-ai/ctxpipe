import { describe, expect, it, vi } from "vitest"
import {
  TransientHttpError,
  withTransientHttpRetry,
} from "./withTransientHttpRetry.js"

describe("withTransientHttpRetry", () => {
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

  it("does not retry on AbortError", async () => {
    const err = new DOMException("aborted", "AbortError")
    await expect(
      withTransientHttpRetry(async () => {
        throw err
      }),
    ).rejects.toBe(err)
  })

  it("stops after exhausting retries on repeated 503", async () => {
    const run = vi.fn().mockImplementation(async () => {
      throw new TransientHttpError("503", 503)
    })
    await expect(withTransientHttpRetry(run, { retries: 2 })).rejects.toThrow(
      TransientHttpError,
    )
    expect(run).toHaveBeenCalledTimes(3)
  })
})
