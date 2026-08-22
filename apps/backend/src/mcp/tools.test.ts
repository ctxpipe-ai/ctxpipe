import { describe, expect, it, vi } from "vitest"

const {
  generateObjectIdMock,
  collectChatMock,
  ensureConversationMock,
  touchConversationLastMessageMock,
  requireCurrentUserIdMock,
  requireCurrentOrgIdMock,
  requireCurrentOrgSlugMock,
  listWorkspacesMock,
  getWorkspaceByIdMock,
} = vi.hoisted(() => ({
  generateObjectIdMock: vi.fn(() => "conv_test"),
  collectChatMock: vi.fn(),
  ensureConversationMock: vi.fn(async () => ({})),
  touchConversationLastMessageMock: vi.fn(async () => {}),
  requireCurrentUserIdMock: vi.fn(() => "user_test123"),
  requireCurrentOrgIdMock: vi.fn(() => "org_test"),
  requireCurrentOrgSlugMock: vi.fn(() => "test-org"),
  listWorkspacesMock: vi.fn(
    async (): Promise<{
      lastUsedWorkspaceId: string | null
      items: Array<{ id: string; createdAt: Date }>
    }> => ({
      lastUsedWorkspaceId: "ws_first",
      items: [
        {
          id: "ws_first",
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
        },
      ],
    }),
  ),
  getWorkspaceByIdMock: vi.fn(async () => ({
    id: "ws_first",
    workspaceRepositoryUrl: "https://github.com/acme/docs",
    desiredSha: "abc",
    desiredGeneration: 1,
    writeStatus: "writable",
    githubConnectionId: "con_github",
  })),
}))

vi.mock("../domain/workspaces/tanstack-workspace-chat.js", () => ({
  collectTanstackWorkspaceChatText: collectChatMock,
}))

vi.mock("../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

vi.mock("../models/conversations.js", () => ({
  ensureConversation: ensureConversationMock,
  touchConversationLastMessage: touchConversationLastMessageMock,
  discardUnstartedConversation: vi.fn(async () => {}),
}))

vi.mock("../auth/context.js", () => ({
  requireCurrentUserId: requireCurrentUserIdMock,
  requireCurrentOrgId: requireCurrentOrgIdMock,
  requireCurrentOrgSlug: requireCurrentOrgSlugMock,
}))

vi.mock("../models/workspaces.js", () => ({
  listWorkspaces: listWorkspacesMock,
  getWorkspaceById: getWorkspaceByIdMock,
}))

vi.mock("../models/github-installation.js", () => ({
  getRepoReadCloneToken: vi.fn(async () => "tok"),
}))

vi.mock("../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))

vi.mock("../observability/langfuse.js", () => ({
  runWithLangfuseContext: (_meta: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock("../observability/amplitude.js", () => ({
  trackMcpToolInvocation: vi.fn(),
}))

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerMcpTools } from "./tools.js"

describe("registerMcpTools", () => {
  it("registers ctx advisor and runs the first-Workspace TanStack chat runtime", async () => {
    collectChatMock.mockImplementationOnce(
      async (input: { onDelta?: (delta: string) => Promise<void> }) => {
        await input.onDelta?.("Plan the integration in phases")
        await input.onDelta?.(" with auth-first steps")
        return {
          ok: true,
          text: "Plan the integration in phases with auth-first steps",
        }
      },
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
    expect(config.description).toContain("DEPRECATED")
    expect(config.description).toContain("first Workspace")

    const sendNotification = vi.fn(async () => {})
    const result = await handler(
      { prompt: "How should we structure this route?" },
      { _meta: { progressToken: "progress_1" }, sendNotification },
    )
    expect(result.content[0]?.text).toBe(
      "Plan the integration in phases with auth-first steps",
    )
    expect(collectChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_test",
        workspaceId: "ws_first",
        prompt: "How should we structure this route?",
        desiredSha: "abc",
      }),
    )
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(ensureConversationMock).toHaveBeenCalledWith({
      id: "conv_test",
      source: "mcp",
      workspaceId: "ws_first",
    })
    expect(touchConversationLastMessageMock).toHaveBeenCalledWith("conv_test")
  })

  it("starts a new MCP conversation even when conversationId is provided", async () => {
    collectChatMock.mockResolvedValueOnce({ ok: true, text: "Response" })
    const registerToolMock = vi.fn()
    const server = { registerTool: registerToolMock } as unknown as McpServer
    registerMcpTools(server)
    const [, , handler] = registerToolMock.mock.calls[0] as [
      string,
      unknown,
      (
        input: { prompt: string; conversationId?: string },
        extra: { sendNotification: (n: unknown) => Promise<void> },
      ) => Promise<{ content: Array<{ text: string }> }>,
    ]
    await handler(
      { prompt: "Test", conversationId: "conv-xyz" },
      { sendNotification: vi.fn(async () => {}) },
    )
    expect(generateObjectIdMock).toHaveBeenCalledWith("conv")
    expect(collectChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv_test" }),
    )
  })

  it("uses the oldest Workspace when no persisted first id exists", async () => {
    collectChatMock.mockResolvedValueOnce({ ok: true, text: "Response" })
    listWorkspacesMock.mockResolvedValueOnce({
      lastUsedWorkspaceId: "ws_newer",
      items: [
        {
          id: "ws_newer",
          createdAt: new Date("2026-08-18T00:00:00.000Z"),
        },
        {
          id: "ws_older",
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
        },
      ],
    })
    getWorkspaceByIdMock.mockResolvedValueOnce({
      id: "ws_older",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      desiredGeneration: 1,
      writeStatus: "writable",
      githubConnectionId: "con_github",
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
    await handler(
      { prompt: "Test" },
      { sendNotification: vi.fn(async () => {}) },
    )
    expect(getWorkspaceByIdMock).toHaveBeenCalledWith("ws_older")
    expect(collectChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_older" }),
    )
  })

  it("fails when the organisation has no Workspace", async () => {
    listWorkspacesMock.mockResolvedValueOnce({
      lastUsedWorkspaceId: null,
      items: [],
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
    await expect(
      handler({ prompt: "Test" }, { sendNotification: vi.fn(async () => {}) }),
    ).rejects.toThrow(/Create a Workspace/)
  })

  it("prefixes currentProjectName onto the Workspace chat prompt", async () => {
    collectChatMock.mockResolvedValueOnce({ ok: true, text: "Response" })
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
    expect(collectChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Project: ctxpipe\n\nTest" }),
    )
  })
})
