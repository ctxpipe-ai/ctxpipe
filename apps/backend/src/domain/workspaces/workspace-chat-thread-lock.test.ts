import {
  chat,
  chatParamsFromRequestBody,
  defineChatMiddleware,
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
import {
  openCodeExtractableUserText,
  openCodeTrailingUserMiddleware,
} from "./workspace-chat-opencode-messages.js"
import {
  workspaceChatPendingTurn,
  workspaceChatThreadLock,
} from "./workspace-chat-thread-lock.js"

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
// A `tanstack_*` tool: the engine runs it and asks the model again.
const engineTool = (id: string): Chunk[] => [
  { type: "TOOL_CALL_START", toolCallId: id, toolCallName: "lookup" },
  { type: "TOOL_CALL_ARGS", toolCallId: id, delta: "{}", args: "{}" },
  { type: "TOOL_CALL_END", toolCallId: id, toolCallName: "lookup", input: {} },
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
  /** The role of the last message that each model call received. */
  readonly lastRoles: Array<string | undefined> = []
  constructor(private readonly turns: Chunk[][]) {
    super({}, "scripted/model")
  }
  async *chatStream(options: {
    runId?: string
    threadId?: string
    messages?: ReadonlyArray<{ role: string }>
  }) {
    this.lastRoles.push(options.messages?.at(-1)?.role)
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
      finishReason:
        body.at(-1)?.type === "TOOL_CALL_END" ? "tool_calls" : "stop",
      timestamp,
    } as never
  }
  async structuredOutput(): Promise<never> {
    throw new Error("Not used")
  }
}

/** One conversation: the backend chat with the production middleware order. */
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
    const history = params.messages as ModelMessage[]
    const prompt = openCodeExtractableUserText(
      history.findLast((message) => message.role === "user") ?? {},
    )
    try {
      for await (const chunk of chat({
        adapter: model,
        threadId: "thread",
        runId: params.runId,
        messages: history,
        tools: [
          {
            name: "lookup",
            description: "Look up a fact",
            inputSchema: { type: "object", properties: {} },
            execute: async () => "found",
          },
        ],
        middleware: [
          workspaceChatThreadLock({
            locks,
            loadThread: (id) => persistence.stores.messages.loadThread(id),
          }),
          withPersistence(persistence, { snapshotStreaming: true }),
          openCodeTrailingUserMiddleware(prompt),
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
  return { browser, send, errors, persistence }
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

it("stores only the browser's questions after the engine runs a tool", async () => {
  // Each answer ends a model call on a tool result, so OpenCode needs its
  // prompt copied after it. That copy is not a question.
  const model = new ScriptedModel([
    engineTool("t1"),
    text("p1", "Found"),
    engineTool("t2"),
    text("p2", "Found again"),
  ])
  const { browser, errors, persistence } = conversation(model)
  await browser.sendMessage("First question")
  await browser.sendMessage("Second question")
  await browser.sendMessage("Third question")
  expect(errors).toEqual([])
  // OpenCode still gets the prompt last after each tool result.
  expect(model.lastRoles).toEqual(Array(5).fill("user"))
  const questionIds = (
    messages: ReadonlyArray<{ role: string; id?: string }>,
  ) =>
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.id)
  expect(
    questionIds(await persistence.stores.messages.loadThread("thread")),
  ).toEqual(questionIds(browser.getMessages()))
})

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

it("stores the question and a running run before the sandbox setup, and keeps the question when a stop ends the setup", async () => {
  const persistence = memoryPersistence()
  const stop = new AbortController()
  let setupStarted!: () => void
  const inSetup = new Promise<void>((resolve) => {
    setupStarted = resolve
  })
  // The sandbox setup is the slow step; a stop during it fails the setup.
  const sandboxSetup = defineChatMiddleware({
    name: "sandbox-setup",
    setup: () =>
      new Promise<void>((_, reject) => {
        setupStarted()
        stop.signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        )
      }),
  })
  const run = (async () => {
    for await (const _ of chat({
      adapter: new ScriptedModel([]),
      threadId: "thread",
      runId: "run-1",
      messages: [{ id: "user-1", role: "user", content: "First question" }],
      abortController: stop,
      middleware: [
        workspaceChatThreadLock({
          locks: new InMemoryLockStore(),
          loadThread: (id) => persistence.stores.messages.loadThread(id),
        }),
        withPersistence(persistence),
        workspaceChatPendingTurn(persistence.stores.runs),
        sandboxSetup,
      ],
    }) as AsyncIterable<StreamChunk>);
  })()
  await Promise.race([inSetup, run])

  // A reload during the setup shows the question and attaches to the run.
  const questions = async () =>
    (await persistence.stores.messages.loadThread("thread")).map(
      (message) => message.id,
    )
  expect(await questions()).toEqual(["user-1"])
  expect((await persistence.stores.runs.findActiveRun("thread"))?.runId).toBe(
    "run-1",
  )

  stop.abort()
  await run.catch(() => undefined)
  expect(await questions()).toEqual(["user-1"])
  expect(await persistence.stores.runs.findActiveRun("thread")).toBeNull()
})
