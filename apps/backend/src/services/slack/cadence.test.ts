import { describe, expect, it } from "vitest"
import {
  isSlackDirtyThreadReady,
  SLACK_MAX_LAG_MS,
  SLACK_THREAD_QUIET_MS,
} from "./cadence.js"

describe("isSlackDirtyThreadReady", () => {
  const now = new Date("2026-08-05T00:10:00.000Z")

  it("is ready after quiet period", () => {
    expect(
      isSlackDirtyThreadReady({
        lastEventAt: new Date(now.getTime() - SLACK_THREAD_QUIET_MS),
        firstDirtyAt: now,
        now,
      }),
    ).toBe(true)
  })

  it("is not ready during quiet period with short lag", () => {
    expect(
      isSlackDirtyThreadReady({
        lastEventAt: new Date(now.getTime() - 30_000),
        firstDirtyAt: new Date(now.getTime() - 60_000),
        now,
      }),
    ).toBe(false)
  })

  it("is ready when max lag exceeded even if still chatty", () => {
    expect(
      isSlackDirtyThreadReady({
        lastEventAt: now,
        firstDirtyAt: new Date(now.getTime() - SLACK_MAX_LAG_MS),
        now,
      }),
    ).toBe(true)
  })
})
