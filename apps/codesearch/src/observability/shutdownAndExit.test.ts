import { afterEach, describe, expect, it, vi } from "vitest"
import { shutdownAndExit } from "./shutdownAndExit.js"

describe("shutdownAndExit", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("flushes and then exits 0", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never)
    let flushed = false
    await shutdownAndExit(async () => {
      flushed = true
    })
    expect(flushed).toBe(true)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
