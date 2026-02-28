import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"

const { streamMock, invokeMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  invokeMock: vi.fn(),
}))

vi.mock("../graphs/index.js", () => ({
  chatGraph: {
    stream: streamMock,
    invoke: invokeMock,
  },
}))

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerMcpTools } from "./tools.js"

describe("registerMcpTools", () => {
  it("registers ctx advisor tool and streams progress", async () => {
    const chunkOne = {
      messages: [{ content: "Plan the integration in phases" }],
    }
    const chunkTwo = {
      messages: [{ content: "Plan the integration in phases with auth-first steps" }],
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
  })
})
