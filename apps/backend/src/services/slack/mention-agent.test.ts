import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  formatSlackMentionStatusText,
  isSlackModelConfigured,
  selectSlackMentionIntent,
  stripSlackMentionText,
} from "./mention-agent.js"

const getModelMock = vi.hoisted(() => vi.fn())
const createAgentMock = vi.hoisted(() => vi.fn())

vi.mock("../../graphs/createAgent.js", () => ({
  createAgent: createAgentMock,
}))
vi.mock("../../retrieval/services/modelProvider.js", () => ({
  getModel: getModelMock,
}))

describe("stripSlackMentionText", () => {
  it("treats a bare mention as empty remainder", () => {
    expect(stripSlackMentionText("<@U_BOT>")).toBe("")
    expect(stripSlackMentionText("<@U_BOT>   ")).toBe("")
  })

  it("keeps intent text after the mention", () => {
    expect(stripSlackMentionText("<@U_BOT> capture this")).toBe("capture this")
  })
})

describe("isSlackModelConfigured", () => {
  it("accepts an API key or Bedrock", () => {
    expect(
      isSlackModelConfigured({ MODEL_PROVIDER_API_KEY: "sk" } as never),
    ).toBe(true)
    expect(isSlackModelConfigured({ MODEL_PROVIDER: "bedrock" } as never)).toBe(
      true,
    )
    expect(isSlackModelConfigured({} as never)).toBe(false)
  })
})

describe("selectSlackMentionIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getModelMock.mockReturnValue({})
  })

  it("captures a bare mention without calling the model", async () => {
    await expect(
      selectSlackMentionIntent({
        env: {} as never,
        connectionId: "con_1",
        mentionText: "<@U_BOT>",
      }),
    ).resolves.toEqual({ kind: "capture" })
    expect(createAgentMock).not.toHaveBeenCalled()
  })

  it("captures when the agent calls capture_thread", async () => {
    createAgentMock.mockImplementation(
      ({
        tools,
      }: {
        tools: Array<{ invoke: (input: unknown) => Promise<unknown> }>
      }) => ({
        invoke: async () => {
          await tools[0]?.invoke({})
          return { messages: [] }
        },
      }),
    )

    await expect(
      selectSlackMentionIntent({
        env: { MODEL_PROVIDER_API_KEY: "sk" } as never,
        connectionId: "con_1",
        mentionText: "<@U_BOT> capture this",
      }),
    ).resolves.toEqual({ kind: "capture" })
  })

  it("returns capability for unknown intent", async () => {
    createAgentMock.mockReturnValue({
      invoke: async () => ({ messages: [] }),
    })

    const result = await selectSlackMentionIntent({
      env: { MODEL_PROVIDER_API_KEY: "sk" } as never,
      connectionId: "con_1",
      mentionText: "<@U_BOT> what is ctxpipe?",
    })

    expect(result).toEqual({ kind: "capability" })
    if (result.kind !== "capability") throw new Error("expected capability")
    expect(formatSlackMentionStatusText(result)).toMatch(/Ask me to capture/)
  })

  it("fails when remainder needs a model that is not configured", async () => {
    await expect(
      selectSlackMentionIntent({
        env: {} as never,
        connectionId: "con_1",
        mentionText: "<@U_BOT> capture this",
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      errorCode: "model_not_configured",
    })
    expect(createAgentMock).not.toHaveBeenCalled()
  })
})
