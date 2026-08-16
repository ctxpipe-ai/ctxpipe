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

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
}))

vi.mock("../../models/conversations.js", () => ({
  getConversation: getConversationMock,
  listConversationsPaginated: listConversationsPaginatedMock,
  ensureConversation: ensureConversationMock,
  touchConversationLastMessage: touchConversationLastMessageMock,
  persistConversationLastBranch: persistConversationLastBranchMock,
  discardUnstartedConversation: discardUnstartedConversationMock,
  updateConversation: updateConversationMock,
  deleteConversation: deleteConversationMock,
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

import { conversationRoutes } from "./conversations.js"

const conversationRow = {
  id: "conv_1",
  orgId: "org_mock",
  userId: "user_test",
  workspaceId: "ws_abc",
  name: "Repo layout",
  source: "ui",
  lastBranch: null,
  lastMessageAt: new Date("2026-08-16T10:00:00.000Z"),
  createdAt: new Date("2026-08-16T09:00:00.000Z"),
  updatedAt: new Date("2026-08-16T10:00:00.000Z"),
}

function app() {
  const hono = new OpenAPIHono<AppEnv>()
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
      writeStatus: "writable",
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

  it("touches last activity only after the stream starts", async () => {
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
    expect(toResponse).toHaveBeenCalled()
    expect(touchConversationLastMessageMock).toHaveBeenCalledWith("conv_1")
    expect(discardUnstartedConversationMock).not.toHaveBeenCalled()
  })
})
