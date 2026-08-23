import type { StreamChunk } from "@tanstack/ai"
import { describe, expect, it } from "vitest"
import {
  parseSseDataLines,
  workspaceChatRunStarted,
  withWorkspaceChatHeartbeats,
} from "./workspace-chat-agui.js"

describe("workspace chat AG-UI", () => {
  it("emits RUN_STARTED before a slow producer yields OpenCode chunks", async () => {
    let openCodeStarted = false
    async function* slow() {
      await new Promise((resolve) => setTimeout(resolve, 20))
      openCodeStarted = true
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "hi" } as const
    }
    const events: object[] = []
    for await (const chunk of (async function* () {
      yield workspaceChatRunStarted({ conversationId: "conv_1", runId: "run_1" })
      yield* slow()
    })()) {
      events.push(chunk)
      if (events.length === 1) {
        expect(openCodeStarted).toBe(false)
        expect(events[0]).toMatchObject({ type: "RUN_STARTED" })
      }
    }
    expect(openCodeStarted).toBe(true)
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
    ])
  })

  it("keeps a heartbeat comment-equivalent CUSTOM event while the producer is idle", async () => {
    async function* idle(): AsyncGenerator<StreamChunk> {
      await new Promise((resolve) => setTimeout(resolve, 30))
      yield {
        type: "RUN_FINISHED",
        threadId: "conv_1",
        runId: "run_1",
        timestamp: Date.now(),
      } as StreamChunk
    }
    const types: string[] = []
    for await (const chunk of withWorkspaceChatHeartbeats(idle(), 10)) {
      types.push(chunk.type)
    }
    expect(types[0]).toBe("CUSTOM")
    expect(types.at(-1)).toBe("RUN_FINISHED")
  })

  it("parses SSE data lines for contract proofs", () => {
    const events = parseSseDataLines(
      'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hi"}\n\n',
    )
    expect(events).toEqual([
      { type: "RUN_STARTED" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "Hi" },
    ])
  })
})
