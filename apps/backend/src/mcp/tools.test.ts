import { HumanMessage } from "@langchain/core/messages"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  generateObjectIdMock,
  streamMock,
  invokeMock,
  ensureConversationMock,
  touchConversationLastMessageMock,
  requireCurrentUserIdMock,
  requireCurrentOrgIdMock,
  requireCurrentOrgSlugMock,
  withOrgDbContextMock,
  createLoggerMock,
  loggerErrorMock,
  loggerWarnMock,
  withLoggerMock,
} = vi.hoisted(() => ({
  generateObjectIdMock: vi.fn(() => "thr_test"),
  streamMock: vi.fn(),
  invokeMock: vi.fn(),
  ensureConversationMock: vi.fn(async () => ({})),
  touchConversationLastMessageMock: vi.fn(async () => {}),
  requireCurrentUserIdMock: vi.fn(() => "user_test123"),
  requireCurrentOrgIdMock: vi.fn(() => "org_test"),
  requireCurrentOrgSlugMock: vi.fn(() => "test-org"),
  withOrgDbContextMock: vi.fn(
    async (_orgId: string, handler: () => Promise<unknown>) => handler(),
  ),
  createLoggerMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  withLoggerMock: vi.fn(
    async (_logger: unknown, handler: () => Promise<unknown>) => handler(),
  ),
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

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../observability/logger.js", () => ({
  createLogger: createLoggerMock,
  getLogger: () => ({
    error: loggerErrorMock,
    warn: loggerWarnMock,
  }),
  withLogger: withLoggerMock,
}))

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MCP_PROGRESS_HEARTBEAT_MS, registerMcpTools } from "./tools.js"

describe("registerMcpTools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamMock.mockReset()
    invokeMock.mockReset()
    generateObjectIdMock.mockReset().mockReturnValue("thr_test")
    ensureConversationMock.mockReset().mockResolvedValue({})
    touchConversationLastMessageMock.mockReset().mockResolvedValue(undefined)
    createLoggerMock.mockReset().mockReturnValue({})
    loggerErrorMock.mockReset()
    loggerWarnMock.mockReset()
    withLoggerMock
      .mockReset()
      .mockImplementation(
        async (_logger: unknown, handler: () => Promise<unknown>) => handler(),
      )
    withOrgDbContextMock
      .mockReset()
      .mockImplementation(
        async (_orgId: string, handler: () => Promise<unknown>) => handler(),
      )
  })

  it("does not hold an org transaction across the advisor graph", async () => {
    const events: string[] = []
    withOrgDbContextMock.mockImplementation(
      async (_orgId: string, handler: () => Promise<unknown>) => {
        events.push("txn-enter")
        try {
          return await handler()
        } finally {
          events.push("txn-exit")
        }
      },
    )
    streamMock.mockImplementation(async () => {
      events.push("stream")
      return (async function* () {
        yield { messages: [{ content: "Org has no indexed context yet." }] }
      })()
    })

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)
    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string },
        extra: { sendNotification: (n: unknown) => Promise<void> },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]

    const result = await handler(
      { prompt: "What standards apply?" },
      { sendNotification: vi.fn(async () => {}) },
    )

    expect(result.content[0]?.text).toBe("Org has no indexed context yet.")
    expect(withOrgDbContextMock).toHaveBeenCalledWith(
      "org_test",
      expect.any(Function),
    )
    expect(events).toContain("stream")
    let depth = 0
    let streamInsideTxn = false
    for (const event of events) {
      if (event === "txn-enter") depth += 1
      if (event === "txn-exit") depth -= 1
      if (event === "stream" && depth > 0) streamInsideTxn = true
    }
    expect(streamInsideTxn).toBe(false)
  })

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
        annotations: {
          readOnlyHint: boolean
          destructiveHint: boolean
          idempotentHint: boolean
          openWorldHint: boolean
        }
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
    expect(config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    })
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
    expect(sendNotification).toHaveBeenCalledTimes(3)
    expect(sendNotification).toHaveBeenNthCalledWith(1, {
      method: "notifications/progress",
      params: {
        progressToken: "progress_1",
        progress: 1,
        message: "Searching organisation context…",
      },
    })
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

  it("sends progress heartbeats while retrieval is quiet", async () => {
    vi.useFakeTimers()
    let finishStream!: () => void
    const streamGate = new Promise<void>((resolve) => {
      finishStream = resolve
    })
    streamMock.mockResolvedValueOnce(
      (async function* () {
        await streamGate
        yield { messages: [{ content: "Grounded answer" }] }
      })(),
    )

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

    const resultPromise = handler(
      { prompt: "Search everything" },
      { _meta: { progressToken: 0 }, sendNotification },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        progressToken: 0,
        message: "Searching organisation context…",
      }),
    })

    await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS)
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        progressToken: 0,
        message: "Still searching organisation context…",
      }),
    })

    finishStream()
    await vi.advanceTimersByTimeAsync(0)
    await expect(resultPromise).resolves.toMatchObject({
      content: [{ text: "Grounded answer" }],
    })
    vi.useRealTimers()
  })

  it("sends progress heartbeats while conversation setup is blocked", async () => {
    vi.useFakeTimers()
    let finishSetup!: () => void
    const setupGate = new Promise<void>((resolve) => {
      finishSetup = resolve
    })
    ensureConversationMock.mockImplementationOnce(async () => {
      await setupGate
      return {}
    })
    streamMock.mockResolvedValueOnce(
      (async function* () {
        yield { messages: [{ content: "Grounded answer" }] }
      })(),
    )

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

    const resultPromise = handler(
      { prompt: "Search everything" },
      { _meta: { progressToken: 0 }, sendNotification },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        progressToken: 0,
        message: "Searching organisation context…",
      }),
    })

    await vi.advanceTimersByTimeAsync(MCP_PROGRESS_HEARTBEAT_MS)
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        progressToken: 0,
        message: "Still searching organisation context…",
      }),
    })

    finishSetup()
    await vi.advanceTimersByTimeAsync(0)
    await expect(resultPromise).resolves.toMatchObject({
      content: [{ text: "Grounded answer" }],
    })
    vi.useRealTimers()
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
        input: {
          prompt: string
          currentProjectName?: string
          conversationId?: string
        },
        extra: {
          _meta?: { progressToken?: string }
          sendNotification: (n: unknown) => Promise<void>
        },
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
      "org_test_user_test123_my-backend_conv-xyz",
    )
    expect(ensureConversationMock).toHaveBeenCalledWith({
      id: "org_test_user_test123_my-backend_conv-xyz",
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

  it("does not treat the user prompt as advisor progress or the answer", async () => {
    streamMock.mockResolvedValueOnce(
      (async function* () {
        yield {
          messages: [{ content: "How should we structure this route?" }],
        }
      })(),
    )

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)
    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string },
        extra: {
          _meta?: { progressToken?: string }
          sendNotification: (notification: unknown) => Promise<void>
        },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]
    const sendNotification = vi.fn(async () => {})

    const result = await handler(
      { prompt: "How should we structure this route?" },
      { _meta: { progressToken: "progress_prompt" }, sendNotification },
    )

    expect(result.content[0]?.text).toBe("No answer could be produced.")
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        message: "Searching organisation context…",
      }),
    })
    expect(sendNotification).not.toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        message: "How should we structure this route?",
      }),
    })
  })

  it("returns a tool error instead of rejecting when the graph throws", async () => {
    streamMock.mockRejectedValueOnce(
      new Error("codesearch failed with status 503"),
    )

    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)
    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string },
        extra: { sendNotification: (notification: unknown) => Promise<void> },
      ) => Promise<{
        isError?: boolean
        content: Array<{ text: string }>
      }>,
    ]

    await expect(
      handler(
        { prompt: "Search everything" },
        { sendNotification: vi.fn(async () => {}) },
      ),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ text: "codesearch failed with status 503" }],
    })
  })
})
