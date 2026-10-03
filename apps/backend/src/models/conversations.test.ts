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
