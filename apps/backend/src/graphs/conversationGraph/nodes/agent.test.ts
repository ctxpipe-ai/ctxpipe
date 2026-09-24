import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages"
import { GraphRecursionError } from "@langchain/langgraph"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { streamMock, invokeMock, getConfigMock, warnMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  invokeMock: vi.fn(),
  getConfigMock: vi.fn(),
  warnMock: vi.fn(),
}))

vi.mock("../../createAgent.js", () => ({
  createAgent: () => ({ stream: streamMock }),
}))

vi.mock("../../../retrieval/services/modelProvider.js", () => ({
  getModel: () => ({ invoke: invokeMock }),
}))

vi.mock("../../../tools/listRepositories.js", () => ({
  listRepositoriesTool: {},
}))

vi.mock("../../../tools/repoExplorerTools.js", () => ({
  standardRepoExplorerTools: [],
}))

vi.mock("../../../observability/logger.js", () => ({
  log: { warn: warnMock },
}))

vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getConfig: getConfigMock,
}))

import { agentNode } from "./agent.js"

/** Emits one values chunk of agent state, then fails like the ReAct loop does. */
function streamThatFails(generated: BaseMessage[], error: Error) {
  streamMock.mockImplementation(
    async ({ messages }: { messages: BaseMessage[] }) =>
      (async function* () {
        yield ["values", { messages: [...messages, ...generated] }]
        throw error
      })(),
  )
}

describe("agentNode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConfigMock.mockReturnValue({
      configurable: { thread_id: "thr_1", source: "mcp" },
    })
  })

  it("answers without tools from what the loop gathered when it hits the recursion limit", async () => {
    streamThatFails(
      [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_1",
              name: "search",
              args: { repositoryId: "repo_1", query: "database" },
            },
          ],
        }),
        new ToolMessage({
          content: "error: repository_not_found\nrepositoryId: repo_1",
          tool_call_id: "call_1",
          name: "search",
        }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_2", name: "list_repositories", args: {} }],
        }),
      ],
      new GraphRecursionError("Recursion limit of 20 reached"),
    )
    invokeMock.mockResolvedValue(new AIMessage("Postgres, per ADR-003."))

    const result = await agentNode({
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
    } as never)

    expect(result.messages).toHaveLength(1)
    const answer = String(result.messages?.[0]?.content)
    expect(answer).toMatch(/^Partial answer/)
    expect(answer).toContain("Postgres, per ADR-003.")

    const sent: BaseMessage[] = invokeMock.mock.calls[0]?.[0]
    expect(sent.some((m) => ToolMessage.isInstance(m))).toBe(false)
    expect(
      sent.some((m) => AIMessage.isInstance(m) && m.tool_calls?.length),
    ).toBe(false)
    expect(sent.map((m) => m.text)).toEqual(
      expect.arrayContaining([
        "Which ADRs cover billing?",
        "ADR-012.",
        "Which database does order-service use?",
        "Service order-service WRITES_TO Postgres",
      ]),
    )
    expect(sent.at(-1)?.text).toContain("error: repository_not_found")

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "conversation.agent.recursion_limit",
        threadId: "thr_1",
        toolCalls: [
          {
            name: "search",
            args: { repositoryId: "repo_1", query: "database" },
            error: "error: repository_not_found",
          },
        ],
      }),
    )
  })

  it("rethrows failures other than the recursion limit", async () => {
    streamThatFails([], new Error("model provider unavailable"))

    await expect(
      agentNode({
        messages: [new HumanMessage("hi")],
        retrievalContext: null,
      } as never),
    ).rejects.toThrow("model provider unavailable")
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
