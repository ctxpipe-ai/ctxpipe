import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn(() => "org_1"))
const requireCurrentUserIdMock = vi.hoisted(() => vi.fn(() => "user_1"))
const currentOrgApiKeyMock = vi.hoisted(() =>
  vi.fn((): AppEnv["Variables"]["orgApiKey"] => null),
)
const getOrgDbMock = vi.hoisted(() => vi.fn())

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
  requireCurrentUserId: requireCurrentUserIdMock,
  currentOrgApiKey: currentOrgApiKeyMock,
}))

vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
}))

vi.mock("../db/org-sql.js", () => ({
  withAmbientOrgDb: <T>(fn: () => Promise<T>) => fn(),
}))

import {
  ensureConversation,
  listConversations,
  listConversationsPaginated,
} from "./conversations.js"

const now = new Date("2026-09-14T00:00:00.000Z")

function conversationRow(overrides: { id: string; userId: string }) {
  return {
    id: overrides.id,
    orgId: "org_1",
    userId: overrides.userId,
    name: "New conversation",
    source: "mcp",
    lastMessageAt: now,
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
  return { values, insert }
}

describe("ensureConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgIdMock.mockReturnValue("org_1")
    requireCurrentUserIdMock.mockReturnValue("user_1")
    currentOrgApiKeyMock.mockReturnValue(null)
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
      workspaceId: null,
      source: "mcp",
      name: "New conversation",
    })
  })

  it("returns 404 when the id is taken by another user", async () => {
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

  it("creates org-service conversations with a null userId", async () => {
    currentOrgApiKeyMock.mockReturnValue({
      id: "key_org",
      orgId: "org_1",
      configId: "organization",
    })
    const created = {
      ...conversationRow({ id: "conv_org", userId: "user_1" }),
      userId: null,
    }
    const db = mockEnsureDb({ existing: [], idTaken: [], created: [created] })

    await expect(
      ensureConversation({ id: "conv_org", source: "mcp" }),
    ).resolves.toEqual(created)

    expect(requireCurrentUserIdMock).not.toHaveBeenCalled()
    expect(db.values).toHaveBeenCalledWith({
      id: "conv_org",
      orgId: "org_1",
      userId: null,
      workspaceId: null,
      source: "mcp",
      name: "New conversation",
    })
  })
})

describe("listConversations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgIdMock.mockReturnValue("org_1")
    requireCurrentUserIdMock.mockReturnValue("user_1")
    currentOrgApiKeyMock.mockReturnValue(null)
  })

  it("scopes the signed-in user's list to that userId", async () => {
    const userRow = conversationRow({ id: "c_user", userId: "user_1" })
    const orderBy = vi.fn(async () => [userRow])
    const where = vi.fn(() => ({ orderBy }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    getOrgDbMock.mockReturnValue({ select })

    await expect(listConversations({ source: "mcp" })).resolves.toEqual([
      userRow,
    ])
    expect(requireCurrentUserIdMock).toHaveBeenCalled()
  })
})

describe("listConversationsPaginated", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgIdMock.mockReturnValue("org_1")
    requireCurrentUserIdMock.mockReturnValue("user_1")
    currentOrgApiKeyMock.mockReturnValue(null)
  })

  it("scopes the signed-in user's mcp list to that userId", async () => {
    const userRow = conversationRow({ id: "c_user", userId: "user_1" })
    const limit = vi.fn(async () => [userRow])
    const orderBy = vi.fn(() => ({ limit }))
    const where = vi.fn(() => ({ orderBy }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    getOrgDbMock.mockReturnValue({ select })

    await expect(
      listConversationsPaginated({ source: "mcp", first: 10 }),
    ).resolves.toMatchObject({
      items: [userRow],
    })
    expect(requireCurrentUserIdMock).toHaveBeenCalled()
  })

  it("lists org-service threads without scoping to the admin userId", async () => {
    const orgRow = {
      ...conversationRow({ id: "c_org", userId: "user_1" }),
      userId: null,
    }
    const limit = vi.fn(async () => [orgRow])
    const orderBy = vi.fn(() => ({ limit }))
    const where = vi.fn(() => ({ orderBy }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    getOrgDbMock.mockReturnValue({ select })

    await expect(
      listConversationsPaginated({ orgService: true, first: 10 }),
    ).resolves.toMatchObject({
      items: [orgRow],
    })
    expect(requireCurrentUserIdMock).toHaveBeenCalled()
  })
})
