// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { upgradeItemFixture } from "@/mocks/workspace-upgrades-handlers"

import { useExpiredCheckingKeys } from "./checking-format-clock"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe("useExpiredCheckingKeys", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("stops the clock when the checking state has expired", async () => {
    vi.useFakeTimers()
    let renders = 0
    let expired = false
    // A re-ingestion blocked for the format, while the Workspace has it.
    const checking = upgradeItemFixture({
      key: "clock-stop",
      kind: "reingest",
      status: "blocked",
      blockedReason: "needs_format",
      targetFormat: 3,
    })
    function Probe() {
      renders++
      expired = useExpiredCheckingKeys("acme/docs", [checking], 3).has(
        "clock-stop",
      )
      return null
    }
    const root = createRoot(document.createElement("div"))
    await act(async () => root.render(<Probe />))
    // The clock ticks each second and the minute ends.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(expired).toBe(true)
    const rendersAtExpiry = renders
    // After the minute, no timer renders the card again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(renders).toBe(rendersAtExpiry)
    await act(async () => root.unmount())
  })
})
