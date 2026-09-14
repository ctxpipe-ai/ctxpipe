import { beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn(() => "org_1"))
const requireCurrentUserIdMock = vi.hoisted(() => vi.fn(() => "user_1"))
const currentMcpActorMock = vi.hoisted(() =>
  vi.fn(() => ({ type: "user" as const, userId: "user_1" })),
)
const getOrgDbMock = vi.hoisted(() => vi.fn())

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
  requireCurrentUserId: requireCurrentUserIdMock,
  currentMcpActor: currentMcpActorMock,
}))

vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
}))

import { ensureConversation, listConversations } from "./conversations.js"

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

function mockEnsureDb(opts: {
  existing: unknown[]
  idTaken: unknown[]
  created: unknown[]
}) {
  let selectCalls = 0
  const limit = vi.fn(async () => {
    selectCalls += 1
    return selectCalls === 1 ? opts.existing : opts.idTaken
  })
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  const returning = vi.fn(async () => opts.created)
  const values = vi.fn(() => ({ returning }))
  const insert = vi.fn(() => ({ values }))
  getOrgDbMock.mockReturnValue({ select, insert })
  return { values, insert, limit }
}

describe("ensureConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgIdMock.mockReturnValue("org_1")
    requireCurrentUserIdMock.mockReturnValue("user_1")
    currentMcpActorMock.mockReturnValue({ type: "user", userId: "user_1" })
  })

  it("creates org-service conversations with userId null", async () => {
    currentMcpActorMock.mockReturnValue({
      type: "org-service",
      orgId: "org_1",
    })
    const created = conversationRow({
      id: "org_1_org_proj_conv",
      userId: null,
    })
    const db = mockEnsureDb({ existing: [], idTaken: [], created: [created] })

    await expect(
      ensureConversation({ id: "org_1_org_proj_conv", source: "mcp" }),
    ).resolves.toEqual(created)

    expect(requireCurrentUserIdMock).not.toHaveBeenCalled()
    expect(db.values).toHaveBeenCalledWith({
      id: "org_1_org_proj_conv",
      orgId: "org_1",
      userId: null,
      source: "mcp",
      name: "New Chat",
    })
  })

  it("creates user conversations with the signed-in userId", async () => {
    const created = conversationRow({ id: "conv_user", userId: "user_1" })
    const db = mockEnsureDb({ existing: [], idTaken: [], created: [created] })

    await expect(
      ensureConversation({ id: "conv_user", source: "mcp" }),
    ).resolves.toEqual(created)

    expect(db.values).toHaveBeenCalledWith({
      id: "conv_user",
      orgId: "org_1",
      userId: "user_1",
      source: "mcp",
      name: "New Chat",
    })
  })

  it("returns 404 when the id is taken by another actor", async () => {
    currentMcpActorMock.mockReturnValue({
      type: "org-service",
      orgId: "org_1",
    })
    const db = mockEnsureDb({
      existing: [],
      idTaken: [{ id: "shared_id" }],
      created: [],
    })

    await expect(
      ensureConversation({ id: "shared_id", source: "mcp" }),
    ).rejects.toMatchObject({
      status: 404,
      message: "Conversation not found",
    })
    expect(db.insert).not.toHaveBeenCalled()
  })
})

describe("listConversations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgIdMock.mockReturnValue("org_1")
    requireCurrentUserIdMock.mockReturnValue("user_1")
    currentMcpActorMock.mockReturnValue({ type: "user", userId: "user_1" })
  })

  it("excludes org-service rows with userId null from the signed-in user's list", async () => {
    const userRow = conversationRow({ id: "c_user", userId: "user_1" })
    const orgServiceRow = conversationRow({
      id: "c_org",
      userId: null,
    })
    const findMany = vi.fn(
      async (args: {
        where: { orgId: { eq: string }; userId: { eq: string } }
      }) =>
        [userRow, orgServiceRow].filter(
          (row) =>
            row.orgId === args.where.orgId.eq &&
            row.userId === args.where.userId.eq,
        ),
    )
    getOrgDbMock.mockReturnValue({
      query: { conversations: { findMany } },
    })

    await expect(listConversations({ source: "mcp" })).resolves.toEqual([
      userRow,
    ])
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: { eq: "org_1" },
          userId: { eq: "user_1" },
          source: { eq: "mcp" },
        },
      }),
    )
    expect(requireCurrentUserIdMock).toHaveBeenCalled()
  })
})
