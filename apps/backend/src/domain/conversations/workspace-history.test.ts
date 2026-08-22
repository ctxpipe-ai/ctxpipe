import { beforeEach, describe, expect, it, vi } from "vitest"

const loadTurnsMock = vi.hoisted(() => vi.fn())
const runTanstackWorkspaceChatMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: loadTurnsMock,
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
  workspaceChatStreamReady,
} from "./transport.js"

describe("loadConversationUiMessages", () => {
  beforeEach(() => {
    loadTurnsMock.mockReset()
    runTanstackWorkspaceChatMock.mockReset()
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
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "conv_1:1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
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
