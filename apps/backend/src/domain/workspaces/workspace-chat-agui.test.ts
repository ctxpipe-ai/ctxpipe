import type { StreamChunk } from "@tanstack/ai"
import { describe, expect, it } from "vitest"
import {
  parseSseDataLines,
  takeWorkspaceChatProducer,
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

  it("stops the inner producer when the heartbeat wrapper is returned", async () => {
    let returned = false
    const hanging: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        return {
          next: () => new Promise<IteratorResult<StreamChunk>>(() => {}),
          return: async () => {
            returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }
    const iterator = withWorkspaceChatHeartbeats(hanging, 10)[
      Symbol.asyncIterator
    ]()
    await iterator.next()
    await iterator.return?.(undefined)
    expect(returned).toBe(true)
  })

  it("stops after RUN_FINISHED even when the producer stays open", async () => {
    async function* hangAfterFinish(): AsyncGenerator<object> {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" }
      yield { type: "RUN_FINISHED" }
      await new Promise(() => {})
    }
    const types: string[] = []
    await Promise.race([
      (async () => {
        for await (const chunk of takeWorkspaceChatProducer(hangAfterFinish(), {
          setupMs: 200,
          idleMs: 200,
        })) {
          types.push((chunk as { type: string }).type)
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("producer did not stop")), 150),
      ),
    ])
    expect(types).toEqual(["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"])
  })

  it("errors when the producer goes silent after the first chunk", async () => {
    async function* silent(): AsyncGenerator<object> {
      yield { type: "CUSTOM", name: "opencode.session-id" }
      await new Promise(() => {})
    }
    await expect(async () => {
      for await (const _chunk of takeWorkspaceChatProducer(silent(), {
        setupMs: 20,
        idleMs: 20,
      })) {
        /* drain */
      }
    }).rejects.toThrow(/stalled/)
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
