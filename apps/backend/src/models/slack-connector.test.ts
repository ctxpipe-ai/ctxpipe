import { beforeEach, describe, expect, it, vi } from "vitest"

const whereMock = vi.hoisted(() => vi.fn())
const setMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: setMock })))
const onConflictDoUpdateMock = vi.hoisted(() => vi.fn())
const valuesMock = vi.hoisted(() =>
  vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock })),
)
const insertMock = vi.hoisted(() => vi.fn(() => ({ values: valuesMock })))
const getSystemDbMock = vi.hoisted(() =>
  vi.fn(() => ({ insert: insertMock, update: updateMock })),
)

vi.mock("../db/client.js", () => ({
  getOrgDb: vi.fn(),
  getSystemDb: getSystemDbMock,
  withOrgDbContext: vi.fn(),
}))

import {
  finalizeSlackSyncTargetAfterContentWorkflow,
  markSlackThreadDirty,
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
      expect.objectContaining({ set: { lastEventAt: eventAt } }),
    )
  })
})
