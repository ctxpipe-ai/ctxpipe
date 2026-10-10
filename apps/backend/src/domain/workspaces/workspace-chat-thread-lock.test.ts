import {
  chat,
  chatParamsFromRequestBody,
  type ModelMessage,
  type StreamChunk,
  type UIMessage,
  uiMessagesToWire,
} from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import { InMemoryLockStore } from "@tanstack/ai/locks"
import { ChatClient, stream } from "@tanstack/ai-client"
import { memoryPersistence, withPersistence } from "@tanstack/ai-persistence"
import { expect, it } from "vitest"
import { workspaceChatThreadLock } from "./workspace-chat-thread-lock.js"

const STALE = "Conversation changed during another send; reload before retrying"

// The chunks that `@tanstack/ai-opencode` gives for each kind of first answer.
type Chunk = Record<string, unknown>
const text = (id: string, delta: string): Chunk[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta },
  { type: "TEXT_MESSAGE_END", messageId: id },
]
const tool = (name: string, input: unknown, result: Chunk): Chunk[] => [
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: name },
  {
    type: "TOOL_CALL_ARGS",
    toolCallId: "c1",
    delta: JSON.stringify(input),
    args: JSON.stringify(input),
  },
  { type: "TOOL_CALL_END", toolCallId: "c1", toolCallName: name, input },
  { type: "TOOL_CALL_RESULT", toolCallId: "c1", messageId: "g1", ...result },
]
const firstAnswers: Record<string, Chunk[]> = {
  "text only": text("p1", "Hello"),
  "reasoning, then text": [
    { type: "REASONING_START", messageId: "r1" },
    { type: "REASONING_MESSAGE_START", messageId: "r1", role: "reasoning" },
    { type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "Think" },
    { type: "REASONING_MESSAGE_END", messageId: "r1" },
    { type: "REASONING_END", messageId: "r1" },
    ...text("p1", "Hello"),
  ],
  "two text parts": [...text("p1", "A"), ...text("p2", "B")],
  "text, a tool, text": [
    ...text("p1", "Look"),
    ...tool("bash", { command: "ls" }, { content: "a.txt\nb.txt" }),
    ...text("p2", "Done"),
  ],
  "a JSON tool result": [
    ...tool("search", { q: "x" }, { content: '{"hits":[1,2]}' }),
    ...text("p2", "Done"),
  ],
  "a tool error": [
    ...tool(
      "bash",
      { command: "x" },
      { content: "boom", state: "output-error" },
    ),
    ...text("p2", "Failed"),
  ],
  "a failed run": [
    ...text("p1", "Partial"),
    { type: "RUN_ERROR", message: "model failed" },
  ],
}

/** The model is the environment: each turn sends the next list of chunks. */
class ScriptedModel extends BaseTextAdapter<string, never, [], never> {
  readonly name = "scripted"
  constructor(private readonly turns: Chunk[][]) {
    super({}, "scripted/model")
  }
  async *chatStream(options: { runId?: string; threadId?: string }) {
    const run = { runId: options.runId, threadId: options.threadId }
    const timestamp = Date.now()
    yield { type: "RUN_STARTED", ...run, timestamp } as never
    const body = this.turns.shift() ?? text("p9", "Answer")
    for (const chunk of body)
      yield { model: "scripted/model", timestamp, ...chunk } as never
    if (body.at(-1)?.type === "RUN_ERROR") return
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

/** One conversation: the backend chat with the lock and persistence. */
function conversation(model: ScriptedModel) {
  const persistence = memoryPersistence()
  const locks = new InMemoryLockStore()
  const errors: string[] = []
  let runs = 0
  // The browser's AG-UI body after JSON, as the WebSocket carries it.
  const send = async function* (
    messages: ReadonlyArray<unknown>,
  ): AsyncGenerator<StreamChunk> {
    const params = await chatParamsFromRequestBody(
      JSON.parse(
        JSON.stringify({
          threadId: "thread",
          runId: `run-${++runs}`,
          messages,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      ),
    )
    try {
      for await (const chunk of chat({
        adapter: model,
        threadId: "thread",
        runId: params.runId,
        messages: params.messages as ModelMessage[],
        middleware: [
          workspaceChatThreadLock({
            locks,
            loadThread: (id) => persistence.stores.messages.loadThread(id),
          }),
          withPersistence(persistence, { snapshotStreaming: true }),
        ],
      }) as AsyncIterable<StreamChunk>) {
        if (chunk.type === "RUN_ERROR") errors.push(chunk.message)
        yield chunk
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  const browser = new ChatClient({
    threadId: "thread",
    connection: stream((messages) =>
      send(uiMessagesToWire(messages as UIMessage[])),
    ),
  })
  return { browser, send, errors }
}

for (const [name, answer] of Object.entries(firstAnswers)) {
  it(`accepts the second question after a live answer with ${name}`, async () => {
    const { browser, errors } = conversation(new ScriptedModel([answer]))
    await browser.sendMessage("First question").catch(() => undefined)
    errors.length = 0
    await browser.sendMessage("Second question")
    expect(errors).toEqual([])
    expect(browser.getMessages().at(-1)?.role).toBe("assistant")
  })
}

it("rejects a send whose history does not hold the stored questions", async () => {
  const { browser, send, errors } = conversation(new ScriptedModel([]))
  await browser.sendMessage("First question")
  const firstId = browser.getMessages()[0]?.id
  const late = async (messages: unknown[]) => {
    errors.length = 0
    for await (const _ of send(messages));
    return [...errors]
  }
  // An overlapping send that started from an empty conversation.
  expect(
    await late([{ id: "other", role: "user", content: "First question" }]),
  ).toEqual([STALE])
  // A send from a tab that has not seen the stored first question.
  expect(
    await late([
      { id: "other", role: "user", content: "First question" },
      { id: "a", role: "assistant", content: "Answer" },
      { id: "u2", role: "user", content: "Next" },
    ]),
  ).toEqual([STALE])
  // The same history with the stored ids is accepted.
  expect(
    await late([
      { id: firstId, role: "user", content: "First question" },
      { id: "a", role: "assistant", content: "Answer" },
      { id: "u2", role: "user", content: "Next" },
    ]),
  ).toEqual([])
})
