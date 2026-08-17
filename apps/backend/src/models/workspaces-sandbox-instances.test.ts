import { beforeEach, describe, expect, it, vi } from "vitest"

const getOrgDbMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => fn()),
)

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: vi.fn(() => "org_1"),
  requireCurrentUserId: vi.fn(() => "user_1"),
}))

vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  withOrgDbContext: withOrgDbContextMock,
}))

import { claimSandboxInstance } from "./workspaces.js"

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-existing",
    kind: "job",
    orgId: "org_1",
    workspaceId: "ws_1",
    conversationId: null,
    desiredUrl: "https://github.com/acme/docs",
    desiredGeneration: null,
    desiredSha: "abc",
    state: "live",
    lastHeartbeatAt: new Date("2026-08-17T00:00:00.000Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function mockClaimDb(existing: ReturnType<typeof liveRow>[]) {
  const execute = vi.fn().mockResolvedValue(undefined)
  const limit = vi.fn().mockResolvedValue(existing)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const insert = vi.fn().mockReturnValue({ values })
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ execute, select, insert }),
  )
  getOrgDbMock.mockReturnValue({ transaction, execute, select, insert })
  return { execute, insert, values, transaction, orderBy }
}

describe("claimSandboxInstance", () => {
  beforeEach(() => {
    getOrgDbMock.mockReset()
    withOrgDbContextMock.mockClear()
  })

  it("locks the job identity then inserts when no live row exists", async () => {
    const db = mockClaimDb([])
    const claimed = await claimSandboxInstance({
      id: "job-new",
      kind: "job",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      state: "live",
      lastHeartbeatAt: new Date("2026-08-17T01:00:00.000Z"),
    })
    expect(withOrgDbContextMock).toHaveBeenCalledWith(
      "org_1",
      expect.any(Function),
    )
    expect(db.execute).toHaveBeenCalled()
    const lockSql = db.execute.mock.calls[0]?.[0]
    expect(JSON.stringify(lockSql)).toMatch(/pg_advisory_xact_lock/)
    expect(JSON.stringify(lockSql)).toMatch(/sandbox:job:ws_1/)
    expect(db.insert).toHaveBeenCalled()
    expect(claimed.inserted).toBe(true)
    expect(claimed.record.id).toBe("job-new")
    expect(
      db.orderBy.mock.calls[0]?.some((arg) =>
        JSON.stringify(arg, (key, value) =>
          key === "table" ? undefined : value,
        )?.includes("provider_sandbox_id"),
      ),
    ).toBe(true)
  })

  it("returns the existing live row instead of inserting a second job sandbox", async () => {
    const db = mockClaimDb([liveRow()])
    const claimed = await claimSandboxInstance({
      id: "job-new",
      kind: "job",
      orgId: "org_1",
      workspaceId: "ws_1",
      desiredSha: "def",
      state: "live",
      lastHeartbeatAt: new Date(),
    })
    expect(db.insert).not.toHaveBeenCalled()
    expect(claimed).toEqual({
      inserted: false,
      record: expect.objectContaining({
        id: "job-existing",
        workspaceId: "ws_1",
        state: "live",
      }),
    })
  })
})
