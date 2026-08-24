import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { resetWorkspaceChatTurnClaims } from "../../domain/workspaces/workspace-chat-turn-claim.js"

const getConversationMock = vi.hoisted(() => vi.fn())
const listConversationsPaginatedMock = vi.hoisted(() => vi.fn())
const ensureConversationMock = vi.hoisted(() => vi.fn())
const touchConversationLastMessageMock = vi.hoisted(() => vi.fn())
const persistConversationLastBranchMock = vi.hoisted(() => vi.fn())
const discardUnstartedConversationMock = vi.hoisted(() => vi.fn())
const updateConversationMock = vi.hoisted(() => vi.fn())
const deleteConversationMock = vi.hoisted(() => vi.fn())
const loadConversationUiMessagesMock = vi.hoisted(() => vi.fn())
const parseConversationChatRequestMock = vi.hoisted(() => vi.fn())
const workspaceChatStreamResponseMock = vi.hoisted(() => vi.fn())
const appendConversationTurnMock = vi.hoisted(() => vi.fn(async () => {}))
const loadConversationTurnsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Array<{ role: string; content: string }>> => []),
)

const getWorkspaceByIdMock = vi.hoisted(() => vi.fn())
const getRegisteredChatSandboxMock = vi.hoisted(() => vi.fn())
const collectChatPullRequestTreeMock = vi.hoisted(() => vi.fn())
const reserveConversationChatPrNumberMock = vi.hoisted(() => vi.fn())
const persistConversationLastChatPrNumberMock = vi.hoisted(() => vi.fn())
const createPullRequestWithFilesMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))

vi.mock("../webhooks/github/github-workspace-tip.js", () => ({
  resolveGithubDefaultBranch: vi.fn().mockResolvedValue("main"),
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  githubRefExists: vi.fn().mockResolvedValue(false),
  createPullRequestWithFiles: createPullRequestWithFilesMock,
}))

vi.mock("../../models/github-installation.js", () => ({
  getRepoReadCloneToken: vi.fn().mockResolvedValue("tok"),
}))

vi.mock("../../models/conversations.js", () => ({
  getConversation: getConversationMock,
  listConversationsPaginated: listConversationsPaginatedMock,
  ensureConversation: ensureConversationMock,
  touchConversationLastMessage: touchConversationLastMessageMock,
  persistConversationLastBranch: persistConversationLastBranchMock,
  persistConversationLastChatPrNumber: persistConversationLastChatPrNumberMock,
  reserveConversationChatPrNumber: reserveConversationChatPrNumberMock,
  listOrgConversationsForSandboxGc: vi.fn().mockResolvedValue([]),
  discardUnstartedConversation: discardUnstartedConversationMock,
  updateConversation: updateConversationMock,
  deleteConversation: deleteConversationMock,
}))

vi.mock("../../domain/workspaces/sandbox-registry.js", () => ({
  destroySandboxesForConversation: vi.fn(),
  withDestroyedConversationSandboxes: vi.fn(
    async (_input: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  getChatSandbox: vi.fn(() => null),
  getRegisteredChatSandbox: getRegisteredChatSandboxMock,
}))

vi.mock("../../domain/workspaces/chat-pull-request.js", () => ({
  collectChatPullRequestTree: collectChatPullRequestTreeMock,
  checkoutPublishedChatBranch: vi.fn(async () => {}),
}))

vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: loadConversationTurnsMock,
  appendConversationTurn: appendConversationTurnMock,
}))

vi.mock("../../domain/conversations/transport.js", () => ({
  loadConversationUiMessages: loadConversationUiMessagesMock,
  parseConversationChatRequest: parseConversationChatRequestMock,
  workspaceChatStreamResponse: workspaceChatStreamResponseMock,
}))

vi.mock("../../domain/workspaces/workspace-chat-turn-runtime.js", () => ({
  resolveWorkspaceChatTurnRuntime: vi.fn(async () => ({
    lastBranch: "main",
    defaultBranch: "main",
    cloneToken: "tok",
    writeStatus: "writable",
    desiredUrl: "https://github.com/acme/docs",
    desiredSha: "abc",
    orgId: "org_mock",
    workspaceId: "ws_abc",
  })),
}))

const warmTanstackWorkspaceChatMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const })),
)
vi.mock("../../domain/workspaces/tanstack-workspace-chat.js", () => ({
  warmTanstackWorkspaceChat: warmTanstackWorkspaceChatMock,
}))

import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationRoutes } from "./conversations.js"

const conversationRow = {
  id: "conv_1",
  orgId: "org_mock",
  userId: "user_test",
  workspaceId: "ws_abc",
  name: "Repo layout",
  source: "ui",
  lastBranch: null,
  lastChatPrNumber: null,
  lastMessageAt: new Date("2026-08-16T10:00:00.000Z"),
  createdAt: new Date("2026-08-16T09:00:00.000Z"),
  updatedAt: new Date("2026-08-16T10:00:00.000Z"),
}

function app() {
  const hono = new OpenAPIHono<AppEnv>()
  hono.use(contextStorage())
  hono.use(withTestRequestLogger)
  hono.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    await next()
  })
  hono.route("/conversations", conversationRoutes)
  return hono
}

describe("conversations API", () => {
  beforeEach(() => {
    resetWorkspaceChatTurnClaims()
    vi.clearAllMocks()
    loadConversationTurnsMock.mockResolvedValue([])
    loadConversationUiMessagesMock.mockResolvedValue([])
    parseConversationChatRequestMock.mockResolvedValue({
      prompt: "hello",
      workspaceId: "ws_abc",
      source: "ui",
    })
    workspaceChatStreamResponseMock.mockReturnValue(
      new Response("ok", { status: 200 }),
    )
    appendConversationTurnMock.mockResolvedValue(undefined)
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_abc",
      orgId: "org_mock",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      githubConnectionId: "con_1",
      writeStatus: "writable",
      desiredSha: "abc",
      desiredGeneration: 1,
    })
    getRegisteredChatSandboxMock.mockReturnValue(null)
    collectChatPullRequestTreeMock.mockResolvedValue({
      files: [],
      deletePaths: [],
    })
    reserveConversationChatPrNumberMock.mockResolvedValue(3)
    createPullRequestWithFilesMock.mockResolvedValue({
      pullNumber: 41,
      pullUrl: "https://github.com/acme/docs/pull/41",
      branch: "ctxpipe/chat/conv_1/3",
    })
  })

  it("lists UI conversations for a Workspace and ignores source=all", async () => {
    listConversationsPaginatedMock.mockResolvedValue({
      items: [conversationRow],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })
    const listed = await app().request("/conversations?workspaceId=ws_abc")
    expect(listed.status).toBe(200)
    expect(listConversationsPaginatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ui", workspaceId: "ws_abc" }),
    )

    listConversationsPaginatedMock.mockClear()
    listConversationsPaginatedMock.mockResolvedValue({
      items: [],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })
    await app().request("/conversations?source=mcp&workspaceId=ws_abc")
    expect(listConversationsPaginatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ui", workspaceId: "ws_abc" }),
    )
  })

  it("refuses to list conversations without a Workspace id", async () => {
    const res = await app().request("/conversations")
    expect(res.status).toBe(400)
    expect(listConversationsPaginatedMock).not.toHaveBeenCalled()
  })

  it("404s GET when the conversation is not in the requested Workspace", async () => {
    getConversationMock.mockResolvedValue(null)
    const res = await app().request(
      "/conversations/conv_1?workspaceId=ws_other",
    )
    expect(res.status).toBe(404)
    expect(getConversationMock).toHaveBeenCalledWith("conv_1", {
      workspaceId: "ws_other",
    })
  })

  it("prepares the conversation sandbox without opening a chat turn", async () => {
    ensureConversationMock.mockResolvedValue(conversationRow)
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_abc",
      orgId: "org_mock",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      writeStatus: "read_only",
    })
    const res = await app().request("/conversations/conv_1/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_abc" }),
    })
    expect(res.status).toBe(204)
    expect(warmTanstackWorkspaceChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_1",
        workspaceId: "ws_abc",
      }),
    )
    expect(workspaceChatStreamResponseMock).not.toHaveBeenCalled()
  })

  it("returns GET when the conversation belongs to the Workspace", async () => {
    getConversationMock.mockResolvedValue(conversationRow)
    const res = await app().request("/conversations/conv_1?workspaceId=ws_abc")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversation.workspaceId).toBe("ws_abc")
  })

  it("returns the stream before persisting the user turn", async () => {
    const res = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })

    expect(res.status).toBe(200)
    expect(appendConversationTurnMock).not.toHaveBeenCalled()
    expect(ensureConversationMock).not.toHaveBeenCalled()
    expect(getWorkspaceByIdMock).not.toHaveBeenCalled()
    expect(workspaceChatStreamResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userTurnAccepted: false,
        prompt: "hello",
        onUserPersist: expect.any(Function),
        resolveRuntime: expect.any(Function),
      }),
      expect.any(Request),
    )
  })

  it("refuses product chat without a Workspace id", async () => {
    parseConversationChatRequestMock.mockResolvedValue({
      prompt: "hello",
      workspaceId: "",
    })
    const res = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
      }),
    })
    expect(res.status).toBe(400)
    expect(ensureConversationMock).not.toHaveBeenCalled()
    expect(workspaceChatStreamResponseMock).not.toHaveBeenCalled()
  })

  it("marks the conversation listable when the user turn persist hook runs", async () => {
    const res = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })

    expect(res.status).toBe(200)
    expect(workspaceChatStreamResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userTurnAccepted: false,
        acceptedTurn: expect.objectContaining({
          conversationId: "conv_1",
          release: expect.any(Function),
        }),
        prompt: "hello",
        onError: expect.any(Function),
        onUserPersist: expect.any(Function),
      }),
      expect.any(Request),
    )
    expect(discardUnstartedConversationMock).not.toHaveBeenCalled()
    loadConversationTurnsMock.mockResolvedValue([
      { role: "user", content: "hello" },
    ])
    await workspaceChatStreamResponseMock.mock.calls[0]?.[0].onError()
    expect(discardUnstartedConversationMock).not.toHaveBeenCalled()
  })

  it("forwards AG-UI messages, threadId, and runId into one stream call", async () => {
    ensureConversationMock.mockResolvedValue(conversationRow)
    const messages = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "hello" },
    ]
    parseConversationChatRequestMock.mockResolvedValue({
      prompt: "hello",
      workspaceId: "ws_abc",
      source: "ui",
      messages,
      threadId: "conv_1",
      runId: "run_1",
    })

    const res = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "conv_1",
        runId: "run_1",
        messages,
        forwardedProps: { workspaceId: "ws_abc", source: "ui" },
      }),
    })

    expect(res.status).toBe(200)
    expect(workspaceChatStreamResponseMock).toHaveBeenCalledTimes(1)
    expect(workspaceChatStreamResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello",
        messages,
        threadId: "conv_1",
        runId: "run_1",
        userTurnAccepted: false,
      }),
      expect.any(Request),
    )
  })

  it("keeps a conversation that already has a user turn when the stream errors", async () => {
    ensureConversationMock.mockResolvedValue(conversationRow)
    loadConversationTurnsMock.mockResolvedValue([
      { role: "user", content: "hello" },
    ])

    const res = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })

    expect(res.status).toBe(200)
    await workspaceChatStreamResponseMock.mock.calls[0]?.[0].onError()
    expect(discardUnstartedConversationMock).not.toHaveBeenCalled()
  })

  it("brokers a PR from the live sandbox tree and returns GitHub's pull number", async () => {
    getConversationMock.mockResolvedValue(conversationRow)
    getRegisteredChatSandboxMock.mockReturnValue({
      handle: { exec: vi.fn(), fs: {} },
      desiredUrl: "https://github.com/acme/docs",
      desiredGeneration: 1,
      desiredSha: "abc",
      defaultBranch: "main",
    })
    collectChatPullRequestTreeMock.mockResolvedValue({
      files: [{ path: "knowledge/a.md", content: "hello" }],
      deletePaths: ["knowledge/gone.md"],
    })

    const res = await app().request("/conversations/conv_1/pull-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Chat changes",
        files: [{ path: "client.md", content: "ignored" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      branch: "ctxpipe/chat/conv_1/3",
      prNumber: 41,
      pullUrl: "https://github.com/acme/docs/pull/41",
    })
    expect(createPullRequestWithFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "ctxpipe/chat/conv_1/3",
        files: [{ path: "knowledge/a.md", content: "hello" }],
        deletePaths: ["knowledge/gone.md"],
        requireNewBranch: true,
      }),
    )
    expect(createPullRequestWithFilesMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ path: "client.md", content: "ignored" }],
      }),
    )
    expect(persistConversationLastBranchMock).toHaveBeenCalledWith({
      conversationId: "conv_1",
      lastBranch: "ctxpipe/chat/conv_1/3",
    })
    expect(persistConversationLastChatPrNumberMock).not.toHaveBeenCalled()
  })

  it("rejects a second in-flight turn before persisting another user message", async () => {
    ensureConversationMock.mockResolvedValue(conversationRow)
    const first = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })
    expect(first.status).toBe(200)
    appendConversationTurnMock.mockClear()
    const second = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "again" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })
    expect(second.status).toBe(200)
    expect(await second.text()).toContain("conversation_busy")
    expect(appendConversationTurnMock).not.toHaveBeenCalled()
  })

  it("accepts the next turn after the first stream releases its claim", async () => {
    ensureConversationMock.mockResolvedValue(conversationRow)
    workspaceChatStreamResponseMock.mockImplementation((input: { acceptedTurn?: { release: () => void } }) => {
      input.acceptedTurn?.release()
      return new Response("ok", { status: 200 })
    })
    const first = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })
    expect(first.status).toBe(200)
    const second = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "again" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })
    expect(second.status).toBe(200)
    expect(await second.text()).toBe("ok")
    expect(workspaceChatStreamResponseMock).toHaveBeenCalledTimes(2)
  })

  it("refuses a PR when the chat sandbox is gone", async () => {
    getConversationMock.mockResolvedValue(conversationRow)
    getRegisteredChatSandboxMock.mockReturnValue(null)
    const res = await app().request("/conversations/conv_1/pull-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Chat changes" }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "missing_sandbox" })
    expect(createPullRequestWithFilesMock).not.toHaveBeenCalled()
  })

  it("refuses a PR when captured sandbox metadata is stale", async () => {
    getConversationMock.mockResolvedValue(conversationRow)
    getRegisteredChatSandboxMock.mockReturnValue({
      handle: { exec: vi.fn(), fs: {} },
      desiredUrl: "https://github.com/acme/other",
      desiredGeneration: 1,
      desiredSha: "abc",
      defaultBranch: "main",
    })
    const res = await app().request("/conversations/conv_1/pull-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Chat changes" }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "stale_url" })
    expect(collectChatPullRequestTreeMock).not.toHaveBeenCalled()
  })
})
