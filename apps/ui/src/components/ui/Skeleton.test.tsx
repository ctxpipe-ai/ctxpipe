// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SKELETON_DELAY_MS, SKELETON_MIN_MS, useSkeletonHold } from "./Skeleton"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function Probe(props: { pending: boolean }) {
  return <p>{useSkeletonHold(props.pending) ? "skeleton" : "content"}</p>
}

describe("useSkeletonHold", () => {
  let container: HTMLElement
  let root: Root

  const render = (pending: boolean) =>
    act(() => root.render(<Probe pending={pending} />))
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
  const shown = () => container.textContent

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it("shows content at once when the load ends before the delay", async () => {
    await render(true)
    await advance(SKELETON_DELAY_MS - 100)
    await render(false)
    expect(shown()).toBe("content")
  })

  it("keeps a visible skeleton for the minimum time", async () => {
    await render(true)
    await advance(SKELETON_DELAY_MS + 10)
    await render(false)
    expect(shown()).toBe("skeleton")
    // The skeleton became visible at the delay, so the hold ends
    // `SKELETON_MIN_MS` after that, not after the data arrived.
    await advance(SKELETON_MIN_MS - 20)
    expect(shown()).toBe("skeleton")
    await advance(30)
    expect(shown()).toBe("content")
  })

  it("does not hold a skeleton again after the hold ended", async () => {
    await render(true)
    await advance(SKELETON_DELAY_MS + SKELETON_MIN_MS + 10)
    await render(false)
    await advance(SKELETON_MIN_MS)
    expect(shown()).toBe("content")
  })
})
