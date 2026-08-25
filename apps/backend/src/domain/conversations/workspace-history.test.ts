import { beforeEach, describe, expect, it, vi } from "vitest"

const loadTurnsMock = vi.hoisted(() => vi.fn())
const runTanstackWorkspaceChatMock = vi.hoisted(() => vi.fn())
const loadThreadMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: loadTurnsMock,
}))

vi.mock("../workspaces/workspace-chat-persistence.js", () => ({
  workspaceChatPersistence: () => ({
    stores: {
      messages: {
        loadThread: loadThreadMock,
        saveThread: async () => {},
      },
    },
  }),
}))

vi.mock("../../observability/langfuse.js", () => ({
  getLangfuseHandler: vi.fn(),
  runWithLangfuseContext: (_meta: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock("../workspaces/tanstack-workspace-chat.js", () => ({
  runTanstackWorkspaceChat: runTanstackWorkspaceChatMock,
}))

import {
  createDataStreamConversationTransport,
  loadConversationUiMessages,
  parseConversationChatRequest,
  workspaceChatStreamReady,
} from "./transport.js"

describe("loadConversationUiMessages", () => {
  beforeEach(() => {
    loadTurnsMock.mockReset()
    loadThreadMock.mockReset()
    loadThreadMock.mockResolvedValue([])
    runTanstackWorkspaceChatMock.mockReset()
  })

  it("prefers persisted TanStack messages over text-only turns", async () => {
    loadThreadMock.mockResolvedValueOnce([
      {
        role: "assistant",
        content: "stored",
        thinking: [{ content: "think" }],
      },
    ])
    const messages = await loadConversationUiMessages({
      conversationId: "conv_1",
      checkpointNamespace: "",
      workspaceId: "ws_1",
    })
    expect(loadTurnsMock).not.toHaveBeenCalled()
    expect(messages.length).toBeGreaterThan(0)
    expect(JSON.stringify(messages)).toMatch(/think|stored|thinking/)
  })

  it("loads Workspace turns from Postgres instead of LangGraph", async () => {
    loadTurnsMock.mockResolvedValueOnce([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
    const messages = await loadConversationUiMessages({
      conversationId: "conv_1",
      checkpointNamespace: "",
      workspaceId: "ws_1",
    })
    expect(loadTurnsMock).toHaveBeenCalledWith("conv_1")
    expect(messages).toEqual([
      {
        id: "conv_1:0",
        role: "user",
        parts: [{ type: "text", content: "hello" }],
      },
      {
        id: "conv_1:1",
        role: "assistant",
        parts: [{ type: "text", content: "hi" }],
      },
    ])
  })

  it("returns no transcript without a Workspace id", async () => {
    await expect(
      loadConversationUiMessages({
        conversationId: "conv_1",
        checkpointNamespace: "ns",
      }),
    ).resolves.toEqual([])
    expect(loadTurnsMock).not.toHaveBeenCalled()
  })
})

describe("createDataStreamConversationTransport", () => {
  beforeEach(() => {
    runTanstackWorkspaceChatMock.mockReset()
  })

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
    expect(runTanstackWorkspaceChatMock).not.toHaveBeenCalled()
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

  it("runs TanStack Workspace chat when the Workspace is present", async () => {
    runTanstackWorkspaceChatMock.mockResolvedValueOnce(
      new Response("ok", { status: 200 }),
    )
    const transport = createDataStreamConversationTransport()
    const res = await transport.toResponse({
      conversationId: "conv_1",
      checkpointNamespace: "",
      prompt: "hello",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
    })
    expect(res.status).toBe(200)
    expect(runTanstackWorkspaceChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_1",
        workspaceId: "ws_1",
        orgId: "org_1",
        desiredUrl: "https://github.com/acme/docs",
      }),
    )
  })
})
