import { chatParamsFromRequestBody } from "@tanstack/ai"
import { describe, expect, it } from "vitest"
import {
  ConversationUiMessagesTimeoutError,
  createDataStreamConversationTransport,
  parseConversationChatRequest,
  withConversationLoadDeadline,
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

  it("reads the UI first-message body when official AG-UI params reject", async () => {
    const firstMessageBody = {
      messages: [
        {
          id: "user-pending",
          role: "user",
          content:
            "How does this workspace decide when a hydrate is ready versus failed?",
        },
      ],
      tools: [],
      context: [],
      forwardedProps: { workspaceId: "ws_1", source: "ui" },
    }
    await expect(chatParamsFromRequestBody(firstMessageBody)).rejects.toThrow(
      /threadId must be a string/,
    )
    const parsed = await parseConversationChatRequest(firstMessageBody)
    expect(parsed.prompt).toBe(
      "How does this workspace decide when a hydrate is ready versus failed?",
    )
    expect(parsed.workspaceId).toBe("ws_1")
    expect(parsed.source).toBe("ui")
    expect(parsed.threadId).toBeUndefined()
    expect(parsed.runId).toBeUndefined()
  })

  it("still reads the last user text when tools and context are omitted", async () => {
    const parsed = await parseConversationChatRequest({
      threadId: "conv_1",
      runId: "run_client",
      messages: [{ id: "m1", role: "user" as const, content: "hello" }],
      forwardedProps: { workspaceId: "ws_1" },
    })
    expect(parsed.prompt).toBe("hello")
    expect(parsed.workspaceId).toBe("ws_1")
    expect(parsed.threadId).toBe("conv_1")
    expect(parsed.runId).toBe("run_client")
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

describe("withConversationLoadDeadline", () => {
  it("returns the load result when it finishes before the deadline", async () => {
    await expect(
      withConversationLoadDeadline("conv_1", async () => ["ok"], 50),
    ).resolves.toEqual(["ok"])
  })

  it("rejects with conversationId when persistence hangs past the deadline", async () => {
    const hung = withConversationLoadDeadline(
      "conv_timeout",
      () => new Promise(() => {}),
      20,
    )
    await expect(hung).rejects.toBeInstanceOf(
      ConversationUiMessagesTimeoutError,
    )
    await expect(hung).rejects.toMatchObject({
      conversationId: "conv_timeout",
      name: "ConversationUiMessagesTimeoutError",
    })
  })
})
