import { describe, expect, it } from "vitest"
import { createSplitLargeTextDeltaTransform } from "./uiMessageStreamSplitTextDelta.js"

describe("createSplitLargeTextDeltaTransform", () => {
  it("splits oversized text-delta into multiple chunks with same id", async () => {
    const long = "a".repeat(200)
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          delta: long,
          id: "msg-1",
        })
        controller.close()
      },
    })

    const out = input.pipeThrough(createSplitLargeTextDeltaTransform(96))
    const reader = out.getReader()
    const pieces: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.type === "text-delta" && "delta" in value) {
        pieces.push((value as { delta: string }).delta)
        expect((value as { id?: string }).id).toBe("msg-1")
      }
    }
    expect(pieces.join("")).toBe(long)
    expect(pieces.length).toBeGreaterThan(1)
  })

  it("passes through small deltas unchanged", async () => {
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "hi", id: "x" })
        controller.close()
      },
    })
    const out = input.pipeThrough(createSplitLargeTextDeltaTransform(96))
    const reader = out.getReader()
    const { value } = await reader.read()
    expect(value).toEqual({ type: "text-delta", delta: "hi", id: "x" })
  })
})
