import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"

const {
  generateObjectIdMock,
  streamMock,
  invokeMock,
  ensureConversationMock,
  touchConversationLastMessageMock,
} = vi.hoisted(() => ({
  generateObjectIdMock: vi.fn(() => "thr_test"),
  streamMock: vi.fn(),
  invokeMock: vi.fn(),
  ensureConversationMock: vi.fn(async () => ({})),
  touchConversationLastMessageMock: vi.fn(async () => {}),
}))

vi.mock("../graphs/index.js", () => ({
  chatGraph: {
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
    expect(config.description).toContain("Primary ctx interface")
    expect(config.inputSchema.shape.prompt._def.type).toBe("string")

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
})
