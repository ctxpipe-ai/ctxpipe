import { chat, modelMessagesToUIMessages } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import { memoryPersistence, withPersistence } from "@tanstack/ai-persistence"
import { expect, it } from "vitest"
import { withOrderedTranscript } from "./workspace-chat-reasoning-steps.js"

type Chunk = Record<string, unknown>
const reasoning = (id: string, delta: string): Chunk[] => [
  { type: "REASONING_START", messageId: id },
  { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" },
  { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta },
  { type: "REASONING_MESSAGE_END", messageId: id },
  { type: "REASONING_END", messageId: id },
]
const tool = (id: string): Chunk[] => [
  {
    type: "TOOL_CALL_START",
    toolCallId: id,
    toolCallName: "bash",
    toolName: "bash",
  },
  { type: "TOOL_CALL_ARGS", toolCallId: id, delta: "{}", args: "{}" },
  { type: "TOOL_CALL_END", toolCallId: id, toolCallName: "bash", input: {} },
  {
    type: "TOOL_CALL_RESULT",
    toolCallId: id,
    messageId: `g-${id}`,
    content: "ok",
  },
]

/** The model is the environment: OpenCode sends reasoning without steps. */
class OpenCodeLike extends BaseTextAdapter<string, never, [], never> {
  readonly name = "opencode-like"
  constructor() {
    super({}, "opencode-like/model")
  }
  async *chatStream(options: { runId?: string; threadId?: string }) {
    const run = { runId: options.runId, threadId: options.threadId }
    const timestamp = Date.now()
    yield { type: "RUN_STARTED", ...run, timestamp } as never
    for (const chunk of [
      ...reasoning("r1", "first thought"),
      ...tool("t1"),
      ...reasoning("r2", "second thought"),
      ...tool("t2"),
      { type: "TEXT_MESSAGE_START", messageId: "p1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "p1", delta: "Done" },
      { type: "TEXT_MESSAGE_END", messageId: "p1" },
    ])
      yield { model: "opencode-like/model", timestamp, ...chunk } as never
    yield {
      type: "RUN_FINISHED",
      ...run,
      finishReason: "stop",
      timestamp,
    } as never
  }
  async structuredOutput(): Promise<never> {
    throw new Error("Not used")
  }
}

it("stores reasoning and tool calls in the order they happened", async () => {
  const persistence = memoryPersistence()
  const model = new OpenCodeLike()
  const adapter = withOrderedTranscript(model)
  for await (const _ of chat({
    adapter,
    threadId: "thread",
    runId: "run-1",
    messages: [{ role: "user", content: "Go" }],
    tools: [],
    middleware: [withPersistence(persistence, { snapshotStreaming: true })],
  }) as AsyncIterable<unknown>) {
    // Drain the run.
  }
  const stored = await persistence.stores.messages.loadThread("thread")
  const parts = modelMessagesToUIMessages(stored).flatMap((m) => m.parts)
  expect(
    parts.flatMap((p) =>
      p.type === "thinking"
        ? [`thinking:${p.content}`]
        : p.type === "tool-call"
          ? [`tool:${p.id}`]
          : [],
    ),
  ).toEqual([
    "thinking:first thought",
    "tool:t1",
    "thinking:second thought",
    "tool:t2",
  ])
})
