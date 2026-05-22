import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"

const {
  generateObjectIdMock,
  streamMock,
  invokeMock,
  ensureConversationMock,
  touchConversationLastMessageMock,
  requireCurrentUserIdMock,
  requireCurrentOrgIdMock,
  requireCurrentOrgSlugMock,
} = vi.hoisted(() => ({
  generateObjectIdMock: vi.fn(() => "thr_test"),
  streamMock: vi.fn(),
  invokeMock: vi.fn(),
  ensureConversationMock: vi.fn(async () => ({})),
  touchConversationLastMessageMock: vi.fn(async () => {}),
  requireCurrentUserIdMock: vi.fn(() => "user_test123"),
  requireCurrentOrgIdMock: vi.fn(() => "org_test"),
  requireCurrentOrgSlugMock: vi.fn(() => "test-org"),
}))

vi.mock("../graphs/index.js", () => ({
  conversationGraph: {
    stream: streamMock,
    invoke: invokeMock,
  },
}))

vi.mock("../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

vi.mock("../models/conversations.js", () => ({
  ensureConversation: ensureConversationMock,
  touchConversationLastMessage: touchConversationLastMessageMock,
}))

vi.mock("../auth/context.js", () => ({
  requireCurrentUserId: requireCurrentUserIdMock,
  requireCurrentOrgId: requireCurrentOrgIdMock,
  requireCurrentOrgSlug: requireCurrentOrgSlugMock,
}))

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerMcpTools } from "./tools.js"

describe("registerMcpTools", () => {
  it("registers ctx advisor tool and streams progress", async () => {
    const chunkOne = {
      messages: [{ content: "Plan the integration in phases" }],
    }
    const chunkTwo = {
      messages: [
        { content: "Plan the integration in phases with auth-first steps" },
      ],
    }
    streamMock.mockResolvedValueOnce(
      (async function* () {
        yield chunkOne
        yield chunkTwo
      })(),
    )

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)

    expect(registerToolMock).toHaveBeenCalledTimes(1)
    const [name, config, handler] = registerToolMock.mock.calls[0] as [
      string,
      {
        title: string
        description: string
        inputSchema: { shape: { prompt: { _def: { type: string } } } }
      },
      (
        input: { prompt: string },
        extra: {
          _meta?: { progressToken?: string | number }
          sendNotification: (notification: unknown) => Promise<void>
        },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]
    expect(name).toBe("ctx_advisor")
    expect(config.title).toContain("ctx_advisor")
    expect(config.description).toContain("ctx_advisor")
    expect(config.description).toContain("repository search")
    expect(config.description).toContain("grep")
    expect(config.inputSchema.shape.prompt._def.type).toBe("string")
    expect("currentProjectName" in config.inputSchema.shape).toBe(true)
    expect("conversationId" in config.inputSchema.shape).toBe(true)

    const sendNotification = vi.fn(async () => {})
    const result = await handler(
      { prompt: "How should we structure this route?" },
      { _meta: { progressToken: "progress_1" }, sendNotification },
    )
    expect(result.content[0]?.text).toBe(
      "Plan the integration in phases with auth-first steps",
    )
    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(invokeMock).not.toHaveBeenCalled()

    const callArg = streamMock.mock.calls[0]?.[0] as {
      messages: unknown[]
    }
    expect(callArg.messages).toHaveLength(1)
    expect(callArg.messages[0]).toBeInstanceOf(HumanMessage)
    expect((callArg.messages[0] as HumanMessage).content).toBe(
      "How should we structure this route?",
    )

    const callConfig = streamMock.mock.calls[0]?.[1] as {
      configurable?: {
        checkpoint_ns?: string
        thread_id?: string
        source?: string
      }
    }
    expect(callConfig.configurable?.checkpoint_ns).toBe("ctx_advisor")
    expect(callConfig.configurable?.thread_id).toBe("thr_test")
    expect(callConfig.configurable?.source).toBe("mcp")
    expect(generateObjectIdMock).toHaveBeenCalledWith("thr")
    expect(ensureConversationMock).toHaveBeenCalledWith({
      id: "thr_test",
      source: "mcp",
    })
    expect(touchConversationLastMessageMock).toHaveBeenCalledWith("thr_test")
  })

  it("passes checkpoint config to fallback invoke path", async () => {
    streamMock.mockResolvedValueOnce(
      (async function* () {
        // no chunks on stream, forcing fallback invoke path
      })(),
    )
    invokeMock.mockResolvedValueOnce({
      messages: [{ content: "Fallback response" }],
    })

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)

    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string },
        extra: {
          _meta?: { progressToken?: string | number }
          sendNotification: (notification: unknown) => Promise<void>
        },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]

    const sendNotification = vi.fn(async () => {})
    const result = await handler(
      { prompt: "Use fallback path" },
      { _meta: { progressToken: "progress_2" }, sendNotification },
    )

    expect(result.content[0]?.text).toBe("Fallback response")
    expect(invokeMock).toHaveBeenCalledTimes(1)

    const invokeConfig = invokeMock.mock.calls[0]?.[1] as {
      configurable?: {
        checkpoint_ns?: string
        thread_id?: string
        source?: string
      }
    }
    expect(invokeConfig.configurable?.checkpoint_ns).toBe("ctx_advisor")
    expect(invokeConfig.configurable?.thread_id).toBe("thr_test")
    expect(invokeConfig.configurable?.source).toBe("mcp")
    expect(ensureConversationMock).toHaveBeenCalledWith({
      id: "thr_test",
      source: "mcp",
    })
    expect(touchConversationLastMessageMock).toHaveBeenCalledWith("thr_test")
  })

  it("uses composite threadId when conversationId is provided", async () => {
    generateObjectIdMock.mockClear()
    requireCurrentUserIdMock.mockClear()
    const callCountBefore = streamMock.mock.calls.length
    streamMock.mockResolvedValueOnce(
      (async function* () {
        yield { messages: [{ content: "Response" }] }
      })(),
    )

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)

    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string; currentProjectName?: string; conversationId?: string },
        extra: { _meta?: { progressToken?: string }; sendNotification: (n: unknown) => Promise<void> },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]

    await handler(
      {
        prompt: "Test",
        currentProjectName: "my-backend",
        conversationId: "conv-xyz",
      },
      { sendNotification: vi.fn(async () => {}) },
    )

    expect(requireCurrentUserIdMock).toHaveBeenCalledTimes(1)
    expect(generateObjectIdMock).not.toHaveBeenCalled()

    const lastStreamCall = streamMock.mock.calls[callCountBefore]
    const callConfig = lastStreamCall?.[1] as {
      configurable?: { thread_id?: string }
    }
    expect(callConfig.configurable?.thread_id).toBe(
      "user_test123_my-backend_conv-xyz",
    )
    expect(ensureConversationMock).toHaveBeenCalledWith({
      id: "user_test123_my-backend_conv-xyz",
      source: "mcp",
    })
  })

  it("passes currentProjectName to graph state when provided", async () => {
    const callCountBefore = streamMock.mock.calls.length
    streamMock.mockResolvedValueOnce(
      (async function* () {
        yield { messages: [{ content: "Response" }] }
      })(),
    )

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)

    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string; currentProjectName?: string },
        extra: { sendNotification: (n: unknown) => Promise<void> },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]

    await handler(
      { prompt: "Test", currentProjectName: "ctxpipe" },
      { sendNotification: vi.fn(async () => {}) },
    )

    const lastStreamCall = streamMock.mock.calls[callCountBefore]
    const callArg = lastStreamCall?.[0] as {
      messages: unknown[]
      currentProjectName?: string | null
    }
    expect(callArg.currentProjectName).toBe("ctxpipe")
  })

  it("sets currentProjectName to null when not provided", async () => {
    const callCountBefore = streamMock.mock.calls.length
    streamMock.mockResolvedValueOnce(
      (async function* () {
        yield { messages: [{ content: "Response" }] }
      })(),
    )

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)

    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string; currentProjectName?: string },
        extra: { sendNotification: (n: unknown) => Promise<void> },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]

    await handler(
      { prompt: "Test" },
      { sendNotification: vi.fn(async () => {}) },
    )

    const lastStreamCall = streamMock.mock.calls[callCountBefore]
    const callArg = lastStreamCall?.[0] as {
      messages: unknown[]
      currentProjectName?: string | null
    }
    expect(callArg.currentProjectName).toBeNull()
  })
})
