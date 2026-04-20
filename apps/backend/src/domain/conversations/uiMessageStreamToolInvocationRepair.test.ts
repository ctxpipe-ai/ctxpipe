import { describe, expect, it } from "vitest"
import {
  createToolInvocationRepairTransform,
  syntheticToolNameFromToolCallId,
} from "./uiMessageStreamToolInvocationRepair.js"

describe("syntheticToolNameFromToolCallId", () => {
  it("parses tool_<name>_<opaque> ids (issue CTX-37 shape)", () => {
    expect(
      syntheticToolNameFromToolCallId(
        "tool_list_files_HKlhFchTWEPs9eertVIU",
      ),
    ).toBe("list_files")
  })

  it("returns undefined for non-synthetic ids", () => {
    expect(syntheticToolNameFromToolCallId("call_abc123")).toBeUndefined()
    expect(syntheticToolNameFromToolCallId("tool_")).toBeUndefined()
  })
})

describe("createToolInvocationRepairTransform", () => {
  it("prepends tool-input-start when tool output has no prior invocation", async () => {
    const toolCallId = "tool_list_files_HKlhFchTWEPs9eertVIU"
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "tool-output-available",
          toolCallId,
          output: "ok",
        })
        controller.close()
      },
    })

    const out = input.pipeThrough(createToolInvocationRepairTransform())
    const reader = out.getReader()
    const a = await reader.read()
    const b = await reader.read()

    expect(a.done).toBe(false)
    expect(a.value).toMatchObject({
      type: "tool-input-start",
      toolCallId,
      toolName: "list_files",
      dynamic: true,
    })

    expect(b.done).toBe(false)
    expect(b.value).toMatchObject({
      type: "tool-output-available",
      toolCallId,
      output: "ok",
    })

    expect(await reader.read()).toEqual({ done: true, value: undefined })
  })

  it("does not duplicate when tool-input-start was already seen", async () => {
    const toolCallId = "tool_list_files_HKlhFchTWEPs9eertVIU"
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "tool-input-start",
          toolCallId,
          toolName: "list_files",
          dynamic: true,
        })
        controller.enqueue({
          type: "tool-output-available",
          toolCallId,
          output: "ok",
        })
        controller.close()
      },
    })

    const out = input.pipeThrough(createToolInvocationRepairTransform())
    const reader = out.getReader()
    const chunks: unknown[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toHaveLength(2)
    expect((chunks[0] as { type: string }).type).toBe("tool-input-start")
    expect((chunks[1] as { type: string }).type).toBe("tool-output-available")
  })
})
