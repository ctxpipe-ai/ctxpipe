import { describe, expect, it } from "vitest"

import { recordSpans } from "../../../test/spans.js"
import { CallDeadlineError, withinDeadline } from "./call-deadline.js"

const spans = recordSpans()

describe("withinDeadline", () => {
  it("records the call name, the deadline, and no fired deadline for a call that ends in time", async () => {
    await expect(
      withinDeadline("A quick call", 1_000, async () => "done"),
    ).resolves.toBe("done")
    const span = spans.spanNamed("deadline.call")
    expect(span?.attributes).toMatchObject({
      "ctxpipe.call.name": "A quick call",
      "ctxpipe.call.deadline_ms": 1_000,
      "ctxpipe.call.deadline_fired": false,
    })
    expect(span?.attributes["error.type"]).toBeUndefined()
  })

  it("aborts a hung call at its deadline and records the fired deadline", async () => {
    let aborted = false
    const call = withinDeadline(
      "A hung call",
      20,
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", () => {
            aborted = true
          })
        }),
    )
    const error = await call.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CallDeadlineError)
    expect(String(error)).toContain("A hung call did not finish within 0.02 s")
    expect(aborted).toBe(true)
    expect(spans.spanNamed("deadline.call")?.attributes).toMatchObject({
      "ctxpipe.call.name": "A hung call",
      "ctxpipe.call.deadline_fired": true,
      "error.type": "CallDeadlineError",
    })
  })
})
