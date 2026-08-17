import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getConversationMock = vi.hoisted(() => vi.fn())
const listConversationsPaginatedMock = vi.hoisted(() => vi.fn())
const ensureConversationMock = vi.hoisted(() => vi.fn())
const touchConversationLastMessageMock = vi.hoisted(() => vi.fn())
const persistConversationLastBranchMock = vi.hoisted(() => vi.fn())
const discardUnstartedConversationMock = vi.hoisted(() => vi.fn())
const updateConversationMock = vi.hoisted(() => vi.fn())
const deleteConversationMock = vi.hoisted(() => vi.fn())
const loadConversationUiMessagesMock = vi.hoisted(() => vi.fn())
const toPromptFromIncomingMessageMock = vi.hoisted(() => vi.fn())
const createDataStreamConversationTransportMock = vi.hoisted(() => vi.fn())

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
  getChatSandbox: vi.fn(() => null),
  getRegisteredChatSandbox: getRegisteredChatSandboxMock,
}))

vi.mock("../../domain/workspaces/chat-pull-request.js", () => ({
  collectChatPullRequestTree: collectChatPullRequestTreeMock,
  checkoutPublishedChatBranch: vi.fn(async () => {}),
}))

vi.mock("../../domain/conversations/transport.js", () => ({
  loadConversationUiMessages: loadConversationUiMessagesMock,
  toPromptFromIncomingMessage: toPromptFromIncomingMessageMock,
  createDataStreamConversationTransport:
    createDataStreamConversationTransportMock,
}))

vi.mock("../../domain/conversations/internalNodeMessageFilter.js", () => ({
  filterInternalNodeMessageChunks: (stream: unknown) => stream,
}))

vi.mock("../../domain/conversations/renameStream.js", () => ({
  createRenameStreamEnhancer: () => ({
    wrapGraphStream: (stream: unknown) => stream,
    getFlushTransform: () =>
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
      }),
  }),
}))

import { contextStorage, withTestRequestLogger } from "../../test/hono-test-logger.js"
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
    vi.clearAllMocks()
    loadConversationUiMessagesMock.mockResolvedValue([])
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

  it("lists UI conversations by default and all sources when asked", async () => {
    listConversationsPaginatedMock.mockResolvedValue({
      items: [conversationRow],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })
    const listed = await app().request("/conversations")
    expect(listed.status).toBe(200)
    expect(listConversationsPaginatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ui" }),
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
    await app().request("/conversations?source=all")
    expect(listConversationsPaginatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: undefined }),
    )
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

  it("returns GET when the conversation belongs to the Workspace", async () => {
    getConversationMock.mockResolvedValue(conversationRow)
    const res = await app().request("/conversations/conv_1?workspaceId=ws_abc")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversation.workspaceId).toBe("ws_abc")
  })

  it("discards an unstarted compose row when the stream fails to start", async () => {
    toPromptFromIncomingMessageMock.mockReturnValue("hello")
    ensureConversationMock.mockResolvedValue(conversationRow)
    createDataStreamConversationTransportMock.mockReturnValue({
      toResponse: vi.fn().mockRejectedValue(new Error("model down")),
    })

    const res = await app().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "ui",
        workspaceId: "ws_abc",
      }),
    })

    expect(res.status).toBe(500)
    expect(touchConversationLastMessageMock).not.toHaveBeenCalled()
    expect(discardUnstartedConversationMock).toHaveBeenCalledWith("conv_1")
  })

  it("does not mark the conversation started until the stream finishes", async () => {
    toPromptFromIncomingMessageMock.mockReturnValue("hello")
    ensureConversationMock.mockResolvedValue(conversationRow)
    const toResponse = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }))
    createDataStreamConversationTransportMock.mockReturnValue({ toResponse })

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
    expect(toResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        onFinish: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
    expect(toResponse.mock.calls[0]?.[0].onHeartbeat).toBeUndefined()
    expect(touchConversationLastMessageMock).not.toHaveBeenCalled()
    expect(discardUnstartedConversationMock).not.toHaveBeenCalled()
    await toResponse.mock.calls[0]?.[0].onError()
    expect(discardUnstartedConversationMock).toHaveBeenCalledWith("conv_1")
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
