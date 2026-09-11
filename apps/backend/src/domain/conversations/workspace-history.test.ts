import { describe, expect, it } from "vitest"
import {
  createDataStreamConversationTransport,
  parseConversationChatRequest,
  workspaceChatStreamReady,
} from "./transport.js"

describe("createDataStreamConversationTransport", () => {
  it("fails closed without a Workspace instead of LangGraph product chat", async () => {
    const transport = createDataStreamConversationTransport()
    const res = await transport.toResponse({
      conversationId: "conv_1",
      checkpointNamespace: "",
      prompt: "hello",
      orgId: "org_1",
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "workspace_required" })
    expect(
      workspaceChatStreamReady({
        workspaceId: "ws_1",
        orgId: "org_1",
        desiredUrl: "https://github.com/acme/docs",
      }),
    ).toBe(true)
    expect(
      workspaceChatStreamReady({
        workspaceId: null,
        orgId: "org_1",
        desiredUrl: "https://github.com/acme/docs",
      }),
    ).toBe(false)
  })

  it("keeps AG-UI messages, threadId, and runId when parsing a chat body", async () => {
    const messages = [
      { id: "m1", role: "user" as const, content: "earlier" },
      { id: "m2", role: "assistant" as const, content: "reply" },
      { id: "m3", role: "user" as const, content: "hello" },
    ]
    const parsed = await parseConversationChatRequest({
      threadId: "conv_1",
      runId: "run_client",
      messages,
      tools: [],
      context: [],
      forwardedProps: { workspaceId: "ws_1", source: "ui" },
    })
    expect(parsed).toMatchObject({
      prompt: "hello",
      workspaceId: "ws_1",
      source: "ui",
      threadId: "conv_1",
      runId: "run_client",
    })
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages?.[2]).toMatchObject({
      role: "user",
      content: "hello",
    })
  })

  it("reads the prompt from AG-UI user content parts that use text", async () => {
    const parsed = await parseConversationChatRequest({
      threadId: "conv_1",
      runId: "run_second",
      messages: [
        { id: "m1", role: "user" as const, content: "earlier" },
        { id: "m2", role: "assistant" as const, content: "reply" },
        {
          id: "m3",
          role: "user" as const,
          content: [{ type: "text", text: "next turn" }],
        },
      ],
      tools: [],
      context: [],
      forwardedProps: { workspaceId: "ws_1", source: "ui" },
    })
    expect(parsed.prompt).toBe("next turn")
  })

  it("rejects an official WS reconstruction that drops tools and context", async () => {
    await expect(
      parseConversationChatRequest({
        threadId: "conv_1",
        runId: "run_client",
        messages: [{ id: "m1", role: "user" as const, content: "hello" }],
        forwardedProps: { workspaceId: "ws_1" },
      }),
    ).rejects.toThrow()
  })

  it("accepts the official WS reconstruction with empty tools, context, and state", async () => {
    const parsed = await parseConversationChatRequest({
      threadId: "conv_1",
      runId: "run_client",
      messages: [{ id: "m1", role: "user" as const, content: "hello" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { workspaceId: "ws_1", source: "ui" },
    })
    expect(parsed).toMatchObject({
      prompt: "hello",
      workspaceId: "ws_1",
      source: "ui",
      threadId: "conv_1",
      runId: "run_client",
    })
  })
})
