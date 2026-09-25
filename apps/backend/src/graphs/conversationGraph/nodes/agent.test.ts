import { once } from "node:events"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { END, START, StateGraph } from "@langchain/langgraph"
import { initLogger } from "evlog"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationGraphStateSchema } from "../state.js"

type ChatRequest = {
  tools?: unknown[]
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>
}

const modelEndpoint = {
  requests: [] as ChatRequest[],
  failWith: undefined as string | undefined,
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of req) body += chunk
  return body
}

/**
 * OpenAI-compatible chat endpoint. With tools in the request it keeps asking
 * for a tool that does not exist, so every call fails and the real loop runs
 * into its recursion limit. Without tools it answers.
 */
const server = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req)) as ChatRequest
  modelEndpoint.requests.push(body)

  if (modelEndpoint.failWith) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        error: {
          message: modelEndpoint.failWith,
          type: "invalid_request_error",
        },
      }),
    )
    return
  }

  const responseNumber = modelEndpoint.requests.length
  const withTools = Boolean(body.tools?.length)
  const delta = withTools
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_${responseNumber}`,
            type: "function",
            function: {
              name: "lookup_order_service",
              arguments: JSON.stringify({ service: "order-service" }),
            },
          },
        ],
      }
    : { role: "assistant", content: "Postgres, per ADR-003." }
  const event = (choice: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-${responseNumber}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, ...choice }],
    })}\n\n`

  res.writeHead(200, { "Content-Type": "text/event-stream" })
  res.end(
    event({ delta, finish_reason: null }) +
      event({ delta: {}, finish_reason: withTools ? "tool_calls" : "stop" }) +
      "data: [DONE]\n\n",
  )
})
server.listen(0, "127.0.0.1")
await once(server, "listening")

vi.stubEnv("MODEL_PROVIDER", "openai-like")
vi.stubEnv(
  "MODEL_PROVIDER_URL",
  `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
)
vi.stubEnv("MODEL_PROVIDER_API_KEY", "test")
vi.stubEnv("MODEL_FAST_NAME", "test-model")
vi.stubEnv("MODEL_MEDIUM_NAME", "test-model")
vi.stubEnv("MODEL_HIGH_NAME", "test-model")

const logEvents: Record<string, unknown>[] = []
initLogger({
  silent: true,
  drain: ({ event }) => {
    logEvents.push(event)
  },
})

const { agentNode } = await import("./agent.js")

const graph = new StateGraph(ConversationGraphStateSchema)
  .addNode("agent", agentNode)
  .addEdge(START, "agent")
  .addEdge("agent", END)
  .compile()

const mcpConfig = { configurable: { thread_id: "thr_1", source: "mcp" } }

describe("agentNode", () => {
  beforeEach(() => {
    modelEndpoint.requests = []
    modelEndpoint.failWith = undefined
    logEvents.length = 0
  })

  afterAll(() => {
    server.close()
    vi.unstubAllEnvs()
  })

  it("answers without tools from what the loop gathered when it hits the recursion limit", async () => {
    const result = await graph.invoke(
      {
        messages: [
          new HumanMessage("Which ADRs cover billing?"),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "old_1", name: "list_repositories", args: {} }],
          }),
          new ToolMessage({
            content: "repositories[0]:",
            tool_call_id: "old_1",
            name: "list_repositories",
          }),
          new AIMessage("ADR-012."),
          new HumanMessage("Which database does order-service use?"),
        ],
        retrievalContext: "Service order-service WRITES_TO Postgres",
      },
      mcpConfig,
    )

    const answer = result.messages.at(-1)
    expect(answer?.text).toMatch(/^Partial answer/)
    expect(answer?.text).toContain("Postgres, per ADR-003.")

    const toolLoopRequests = modelEndpoint.requests.filter(
      (r) => r.tools?.length,
    )
    const answerRequests = modelEndpoint.requests.filter(
      (r) => !r.tools?.length,
    )
    expect(answerRequests).toHaveLength(1)
    const sent = answerRequests[0]?.messages ?? []
    expect(sent.some((m) => m.role === "tool" || m.tool_calls?.length)).toBe(
      false,
    )
    expect(sent.map((m) => m.content)).toEqual(
      expect.arrayContaining([
        "Which ADRs cover billing?",
        "ADR-012.",
        "Which database does order-service use?",
        "Service order-service WRITES_TO Postgres",
      ]),
    )
    expect(sent.at(-1)?.content).toContain(
      "lookup_order_service is not a valid tool",
    )

    expect(logEvents).toContainEqual(
      expect.objectContaining({
        level: "warn",
        step: "conversation.agent.recursion_limit",
        threadId: "thr_1",
        toolCalls: Array.from({ length: toolLoopRequests.length - 1 }, () => ({
          name: "lookup_order_service",
          args: { service: "order-service" },
          error: expect.stringMatching(
            /^Error: lookup_order_service is not a valid tool/,
          ),
        })),
      }),
    )
  })

  it("rethrows failures other than the recursion limit", async () => {
    modelEndpoint.failWith = "model provider unavailable"

    await expect(
      graph.invoke({ messages: [new HumanMessage("hi")] }, mcpConfig),
    ).rejects.toThrow("model provider unavailable")
    expect(modelEndpoint.requests.every((r) => r.tools?.length)).toBe(true)
  })
})
