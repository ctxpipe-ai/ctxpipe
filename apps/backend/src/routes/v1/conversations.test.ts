import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())
const listConversationsPaginatedMock = vi.hoisted(() => vi.fn())
const getConversationMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getActiveMemberRole: getActiveMemberRoleMock },
  }),
}))

vi.mock("../../models/conversations.js", () => ({
  listConversationsPaginated: listConversationsPaginatedMock,
  getConversation: getConversationMock,
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  ensureConversation: vi.fn(),
  touchConversationLastMessage: vi.fn(),
}))

vi.mock("../../domain/conversations/renameStream.js", () => ({
  createRenameStreamEnhancer: vi.fn(),
}))

vi.mock("../../domain/conversations/internalNodeMessageFilter.js", () => ({
  filterInternalNodeMessageChunks: vi.fn(),
}))

vi.mock("../../domain/conversations/transport.js", () => ({
  createDataStreamConversationTransport: vi.fn(),
  loadConversationUiMessages: vi.fn(async () => []),
  toPromptFromIncomingMessage: vi.fn(),
}))

import { conversationRoutes } from "./conversations.js"

const now = new Date("2026-09-14T00:00:00.000Z")

function conversationRow(overrides: {
  id: string
  userId: string | null
  source?: string | null
}) {
  return {
    id: overrides.id,
    orgId: "org_1",
    userId: overrides.userId,
    name: "New Chat",
    source: overrides.source ?? "mcp",
    lastMessageAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/conversations", conversationRoutes)
  return app
}

describe("GET /conversations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    listConversationsPaginatedMock.mockResolvedValue({
      items: [],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })
  })

  it("returns 403 when a member lists MCP service conversations", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "member" })

    const res = await createApp().request(
      "/conversations?source=mcp-service&first=10",
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(listConversationsPaginatedMock).not.toHaveBeenCalled()
  })

  it("lists org-service MCP threads for an admin", async () => {
    const row = conversationRow({ id: "c_org", userId: null })
    listConversationsPaginatedMock.mockResolvedValueOnce({
      items: [row],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })

    const res = await createApp().request(
      "/conversations?source=mcp-service&first=10",
    )

    expect(res.status).toBe(200)
    expect(listConversationsPaginatedMock).toHaveBeenCalledWith({
      source: undefined,
      orgService: true,
      first: 10,
      after: undefined,
    })
    const body = (await res.json()) as {
      items: Array<{ userId: string | null }>
    }
    expect(body.items).toEqual([
      expect.objectContaining({ id: "c_org", userId: null, source: "mcp" }),
    ])
  })

  it("keeps source=mcp as the signed-in user's threads", async () => {
    const row = conversationRow({ id: "c_user", userId: "user_1" })
    listConversationsPaginatedMock.mockResolvedValueOnce({
      items: [row],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })

    const res = await createApp().request("/conversations?source=mcp&first=10")

    expect(res.status).toBe(200)
    expect(getActiveMemberRoleMock).not.toHaveBeenCalled()
    expect(listConversationsPaginatedMock).toHaveBeenCalledWith({
      source: "mcp",
      orgService: false,
      first: 10,
      after: undefined,
    })
  })
})

describe("GET /conversations/:id org-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    getConversationMock.mockResolvedValue(null)
  })

  it("returns an org-service thread for an admin after the user-scoped lookup misses", async () => {
    const row = conversationRow({ id: "c_org", userId: null })
    getConversationMock.mockResolvedValueOnce(null).mockResolvedValueOnce(row)

    const res = await createApp().request("/conversations/c_org")

    expect(res.status).toBe(200)
    expect(getConversationMock).toHaveBeenNthCalledWith(1, "c_org")
    expect(getConversationMock).toHaveBeenNthCalledWith(2, "c_org", {
      orgService: true,
    })
  })

  it("returns 404 when a member cannot see an org-service thread", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "member" })
    getConversationMock.mockResolvedValueOnce(null)

    const res = await createApp().request("/conversations/c_org")

    expect(res.status).toBe(404)
    expect(getConversationMock).toHaveBeenCalledTimes(1)
  })
})
