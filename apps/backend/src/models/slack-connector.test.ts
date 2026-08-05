import { beforeEach, describe, expect, it, vi } from "vitest"

const whereMock = vi.hoisted(() => vi.fn())
const setMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: setMock })))
const getSystemDbMock = vi.hoisted(() => vi.fn(() => ({ update: updateMock })))

vi.mock("../db/client.js", () => ({
  getOrgDb: vi.fn(),
  getSystemDb: getSystemDbMock,
  withOrgDbContext: vi.fn(),
}))

import { finalizeSlackSyncTargetAfterContentWorkflow } from "./slack-connector.js"

describe("finalizeSlackSyncTargetAfterContentWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    whereMock.mockResolvedValue(undefined)
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
