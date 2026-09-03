import { beforeEach, describe, expect, it, vi } from "vitest"

const captureSlackThreadMock = vi.hoisted(() => vi.fn())
const getModelMock = vi.hoisted(() => vi.fn())
const createAgentMock = vi.hoisted(() => vi.fn())

vi.mock("../../graphs/createAgent.js", () => ({
  createAgent: createAgentMock,
}))
vi.mock("../../retrieval/services/modelProvider.js", () => ({
  getModel: getModelMock,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))
vi.mock("./sync.js", () => ({
  captureSlackThread: captureSlackThreadMock,
}))

import {
  formatSlackMentionStatusText,
  isSlackModelConfigured,
  runSlackMentionAgent,
  stripSlackMentionText,
} from "./mention-agent.js"

const connection = { id: "con_1", orgId: "org_1", teamId: "T1" }
const target = {
  connectionId: "con_1",
  orgId: "org_1",
  enabled: true,
}
const captured = {
  status: "completed" as const,
  messageCount: 2,
  githubUrl: "https://github.com/acme/context/blob/sha/slack/thread.md",
  truncated: false,
}

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

describe("runSlackMentionAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureSlackThreadMock.mockResolvedValue(captured)
    getModelMock.mockReturnValue({})
  })

  it("captures a bare mention without calling the model", async () => {
    const result = await runSlackMentionAgent({
      orgId: "org_1",
      env: {} as never,
      connection: connection as never,
      target: target as never,
      channelId: "C1",
      threadTs: "1710000000.000100",
      mentionText: "<@U_BOT>",
      mentionUserId: "U1",
    })

    expect(result).toEqual({ kind: "captured", capture: captured })
    expect(captureSlackThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ capturedByUserId: "U1" }),
    )
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

    const result = await runSlackMentionAgent({
      orgId: "org_1",
      env: { MODEL_PROVIDER_API_KEY: "sk" } as never,
      connection: connection as never,
      target: target as never,
      channelId: "C1",
      threadTs: "1710000000.000100",
      mentionText: "<@U_BOT> capture this",
    })

    expect(result.kind).toBe("captured")
    expect(captureSlackThreadMock).toHaveBeenCalledTimes(1)
  })

  it("does not write git for unknown intent", async () => {
    createAgentMock.mockReturnValue({
      invoke: async () => ({ messages: [] }),
    })

    const result = await runSlackMentionAgent({
      orgId: "org_1",
      env: { MODEL_PROVIDER_API_KEY: "sk" } as never,
      connection: connection as never,
      target: target as never,
      channelId: "C1",
      threadTs: "1710000000.000100",
      mentionText: "<@U_BOT> what is ctxpipe?",
    })

    expect(result).toEqual({ kind: "capability" })
    expect(captureSlackThreadMock).not.toHaveBeenCalled()
    expect(formatSlackMentionStatusText(result)).toMatch(/Ask me to capture/)
  })

  it("fails when remainder needs a model that is not configured", async () => {
    const result = await runSlackMentionAgent({
      orgId: "org_1",
      env: {} as never,
      connection: connection as never,
      target: target as never,
      channelId: "C1",
      threadTs: "1710000000.000100",
      mentionText: "<@U_BOT> capture this",
    })

    expect(result).toMatchObject({
      kind: "failed",
      errorCode: "model_not_configured",
    })
    expect(createAgentMock).not.toHaveBeenCalled()
    expect(captureSlackThreadMock).not.toHaveBeenCalled()
  })
})
