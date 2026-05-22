import { describe, expect, it } from "vitest"
import { createTextStartRepairTransform } from "./uiMessageStreamTextStartRepair.js"

describe("createTextStartRepairTransform", () => {
  it("prepends text-start when text-delta arrives without a prior text-start", async () => {
    const msgId = "gen-test-123"
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          id: msgId,
          delta: "hello",
        })
        controller.enqueue({ type: "text-end", id: msgId })
        controller.close()
      },
    })

    const out = input.pipeThrough(createTextStartRepairTransform())
    const reader = out.getReader()
    const chunks: unknown[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toEqual([
      { type: "text-start", id: msgId },
      { type: "text-delta", id: msgId, delta: "hello" },
      { type: "text-end", id: msgId },
    ])
  })

  it("does not duplicate when text-start was already seen", async () => {
    const msgId = "gen-test-456"
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-start", id: msgId })
        controller.enqueue({
          type: "text-delta",
          id: msgId,
          delta: "x",
        })
        controller.close()
      },
    })

    const out = input.pipeThrough(createTextStartRepairTransform())
    const reader = out.getReader()
    const chunks: unknown[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toEqual([
      { type: "text-start", id: msgId },
      { type: "text-delta", id: msgId, delta: "x" },
    ])
  })
})
