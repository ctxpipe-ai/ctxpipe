import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import type { StreamChunk } from "@tanstack/ai"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import {
  bunSocketToWebSocketLike,
  conversationWebSocketHandlers,
} from "./conversation-websocket.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
})

beforeAll(() => {
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

it(
  "puts a UI turn on the WebSocket in the conversation's Langfuse session, with its user and source tag",
  { timeout: 90_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      // The production socket handlers run in this process; only the
      // transport between the browser and Bun is left out.
      const sent: StreamChunk[] = []
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const url = `ws://127.0.0.1/${f.orgSlug}/api/v1/conversations/${f.conversationId}`
      const ws = {
        data: {
          kind: "workspace-chat" as const,
          orgSlug: f.orgSlug,
          orgId: f.orgId,
          conversationId: f.conversationId,
          userId: f.userId,
          request: new Request(url.replace("ws:", "http:")),
          socket: bunSocketToWebSocketLike({ send() {}, close() {} }),
        },
        readyState: 1,
        send(data: string) {
          const frame = JSON.parse(data) as { chunk?: StreamChunk }
          if (!frame.chunk) return
          sent.push(frame.chunk)
          if (
            frame.chunk.type === "RUN_FINISHED" ||
            frame.chunk.type === "RUN_ERROR"
          )
            finish()
        },
        close() {},
      }
      conversationWebSocketHandlers.open(ws)
      conversationWebSocketHandlers.message(
        ws,
        JSON.stringify({
          threadId: f.conversationId,
          runId: `run-${f.conversationId}`,
          messages: [{ id: "user-1", role: "user", content: "Hello socket" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { workspaceId: f.workspaceId, source: "ui" },
        }),
      )
      await finished
      conversationWebSocketHandlers.close(ws)

      expect(sent.at(-1)?.type).toBe("RUN_FINISHED")
      // The turn and chat spans start in the turn's context. The generation
      // spans start in the model proxy's own HTTP request.
      const turnSpans = await vi.waitFor(() => {
        const spans = exporter
          .getFinishedSpans()
          .filter(
            (span) =>
              span.name === "workspace-chat.turn" ||
              span.name.startsWith("chat "),
          )
        if (!spans.some((span) => span.name === "workspace-chat.turn"))
          throw new Error("The turn span has not ended")
        return spans
      })
      for (const span of turnSpans) {
        expect(span.attributes["session.id"]).toBe(f.conversationId)
        expect(span.attributes["user.id"]).toBe(f.userId)
        expect(span.attributes["langfuse.trace.tags"]).toEqual(
          expect.arrayContaining(["ui"]),
        )
      }
    })
  },
)

it(
  "answers a second question on the same socket, with the messages the browser holds",
  { timeout: 120_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const turns: StreamChunk[][] = []
      let finish = () => {}
      const url = `http://127.0.0.1/${f.orgSlug}/api/v1/conversations/${f.conversationId}`
      const ws = {
        data: {
          kind: "workspace-chat" as const,
          orgSlug: f.orgSlug,
          orgId: f.orgId,
          conversationId: f.conversationId,
          userId: f.userId,
          request: new Request(url),
          socket: bunSocketToWebSocketLike({ send() {}, close() {} }),
        },
        readyState: 1,
        send(data: string) {
          // A durable chunk comes with its offset; a turn error comes bare.
          const frame = JSON.parse(data) as StreamChunk | { chunk: StreamChunk }
          const chunk = "chunk" in frame ? frame.chunk : frame
          turns.at(-1)?.push(chunk)
          if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR")
            finish()
        },
        close() {},
      }
      const ask = async (runId: string, messages: unknown[]) => {
        turns.push([])
        const finished = new Promise<void>((resolve) => {
          finish = resolve
        })
        conversationWebSocketHandlers.message(
          ws,
          JSON.stringify({
            threadId: f.conversationId,
            runId,
            messages,
            tools: [],
            context: [],
            state: {},
            forwardedProps: { workspaceId: f.workspaceId, source: "ui" },
          }),
        )
        await finished
        return turns.at(-1) ?? []
      }
      conversationWebSocketHandlers.open(ws)
      const first = { id: "user-1", role: "user", content: "First question" }
      const one = await ask(`run-1-${f.conversationId}`, [first])
      expect(one.at(-1)?.type).toBe("RUN_FINISHED")
      // The browser keeps the streamed answer under the id the stream gave it.
      const answerId = one.find(
        (chunk) => chunk.type === "TEXT_MESSAGE_START",
      )?.messageId
      const two = await ask(`run-2-${f.conversationId}`, [
        first,
        {
          id: answerId,
          role: "assistant",
          content: one
            .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
            .map((chunk) => chunk.delta)
            .join(""),
        },
        { id: "user-2", role: "user", content: "Second question" },
      ])
      conversationWebSocketHandlers.close(ws)
      expect(two.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual([])
      expect(two.at(-1)?.type).toBe("RUN_FINISHED")
      expect(
        two
          .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
          .map((chunk) => chunk.delta)
          .join(""),
      ).toBe("Native reply completed.")
    })
  },
)
