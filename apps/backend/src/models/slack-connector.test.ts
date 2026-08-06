import { beforeEach, describe, expect, it, vi } from "vitest"

const eqMock = vi.hoisted(() =>
  vi.fn((column: unknown, value: unknown) => ({ column, value })),
)
const andMock = vi.hoisted(() =>
  vi.fn((...conditions: unknown[]) => conditions),
)
const whereMock = vi.hoisted(() => vi.fn())
const returningMock = vi.hoisted(() => vi.fn())
const setMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: setMock })))
const onConflictDoUpdateMock = vi.hoisted(() => vi.fn())
const valuesMock = vi.hoisted(() =>
  vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock })),
)
const insertMock = vi.hoisted(() => vi.fn(() => ({ values: valuesMock })))
const deleteMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const limitMock = vi.hoisted(() => vi.fn())
const selectWhereMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const fromMock = vi.hoisted(() => vi.fn(() => ({ where: selectWhereMock })))
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })))
const transactionMock = vi.hoisted(() => vi.fn())
const getOrgDbMock = vi.hoisted(() =>
  vi.fn(() => ({ transaction: transactionMock })),
)
const getSystemDbMock = vi.hoisted(() =>
  vi.fn(() => ({
    delete: deleteMock,
    insert: insertMock,
    update: updateMock,
  })),
)

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  and: andMock,
  eq: eqMock,
}))
vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  getSystemDb: getSystemDbMock,
  withOrgDbContext: vi.fn(),
}))
vi.mock("./github-installation.js", () => ({
  listGithubConnectionsForOrg: vi.fn().mockResolvedValue([]),
}))

import {
  clearSlackDirtyThreads,
  finalizeSlackSyncTargetAfterContentWorkflow,
  markSlackThreadDirty,
  patchSlackConnectorConfig,
  SlackConfigPrCreationInProgressError,
} from "./slack-connector.js"

describe("finalizeSlackSyncTargetAfterContentWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    whereMock.mockResolvedValue(undefined)
    onConflictDoUpdateMock.mockResolvedValue(undefined)
  })

  it.each([
    "failed",
    "partial_failed",
  ] as const)("does not promote a %s initial sync to live", async (workflowStatus) => {
    await finalizeSlackSyncTargetAfterContentWorkflow({
      connectionId: "con_1",
      workflowStatus,
    })

    expect(updateMock).not.toHaveBeenCalled()
  })

  it("promotes only a completed initial sync to live", async () => {
    await finalizeSlackSyncTargetAfterContentWorkflow({
      connectionId: "con_1",
      workflowStatus: "completed",
    })

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupPhase: "live",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
      }),
    )
    expect(whereMock).toHaveBeenCalledOnce()
  })
})

describe("markSlackThreadDirty", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onConflictDoUpdateMock.mockResolvedValue(undefined)
  })

  it("atomically refreshes an existing dirty thread", async () => {
    const eventAt = new Date("2026-08-06T12:00:00.000Z")

    await markSlackThreadDirty({
      connectionId: "con_1",
      channelId: "C1",
      threadTs: "123.456",
      eventAt,
    })

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "123.456",
        firstDirtyAt: eventAt,
        lastEventAt: eventAt,
      }),
    )
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          lastEventAt: eventAt,
          revision: expect.anything(),
        }),
      }),
    )
  })
})

describe("clearSlackDirtyThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    whereMock.mockResolvedValue(undefined)
  })

  it("deletes only the dirty-row version processed by the flush", async () => {
    await clearSlackDirtyThreads({
      connectionId: "con_1",
      keys: [{ id: "sdt_1", revision: 7 }],
    })

    expect(eqMock.mock.calls.some(([, value]) => value === 7)).toBe(true)
  })
})

describe("patchSlackConnectorConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transactionMock.mockImplementation(
      (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          delete: deleteMock,
          insert: insertMock,
          select: selectMock,
          update: updateMock,
        }),
    )
    limitMock.mockResolvedValue([
      {
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: true,
        setupPhase: "awaiting_merge",
      },
    ])
    returningMock.mockResolvedValue([])
    whereMock.mockReturnValue({ returning: returningMock })
  })

  it("rejects before changing config when another PR workflow holds the claim", async () => {
    await expect(
      patchSlackConnectorConfig({
        orgId: "org_1",
        connectionId: "con_1",
        channels: [{ channelId: "C1", name: "engineering", isPrivate: false }],
        claimConfigPrCreation: true,
      }),
    ).rejects.toBeInstanceOf(SlackConfigPrCreationInProgressError)

    expect(deleteMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })
})
