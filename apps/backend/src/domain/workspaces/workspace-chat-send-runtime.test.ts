import { beforeEach, describe, expect, it, vi } from "vitest"

const ensureConversationMock = vi.hoisted(() => vi.fn())
const getWorkspaceByIdMock = vi.hoisted(() => vi.fn())
const resolveWorkspaceChatTurnRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/conversations.js", () => ({
  ensureConversation: ensureConversationMock,
  touchConversationLastMessage: vi.fn(async () => {}),
}))
vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
}))
vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))
vi.mock("./workspace-chat-turn-runtime.js", () => ({
  resolveWorkspaceChatTurnRuntime: resolveWorkspaceChatTurnRuntimeMock,
}))

import { resolveWorkspaceChatSendRuntime } from "./workspace-chat-send-runtime.js"

describe("resolveWorkspaceChatSendRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("loads workspace identity from the conversation row", async () => {
    ensureConversationMock.mockResolvedValue({
      id: "conv_cold",
      workspaceId: "ws_1",
    })
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      orgId: "org_1",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      githubConnectionId: null,
      writeStatus: "read_only",
      desiredSha: "abc",
    })
    resolveWorkspaceChatTurnRuntimeMock.mockResolvedValue({
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      writeStatus: "read_only",
      lastBranch: "ctxpipe/chat/conv_cold/1",
      cloneToken: null,
    })
    const resolved = await resolveWorkspaceChatSendRuntime({
      conversationId: "conv_cold",
      workspaceId: "ws_1",
    })
    expect(resolved.desiredUrl).toBe("https://github.com/acme/docs")
    expect(resolved.lastBranch).toBe("ctxpipe/chat/conv_cold/1")
    expect(ensureConversationMock).toHaveBeenCalled()
    expect(getWorkspaceByIdMock).toHaveBeenCalled()
  })
})
