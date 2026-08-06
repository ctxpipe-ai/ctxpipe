import { beforeEach, describe, expect, it, vi } from "vitest"

const markInitialSyncMock = vi.hoisted(() => vi.fn())
const markFailedMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../models/slack-connector.js", () => ({
  markSlackSyncTargetFailed: markFailedMock,
  markSlackSyncTargetInitialSync: markInitialSyncMock,
}))
vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("./workflows/slack-sync-content.js", () => ({
  slackSyncContent: { spec: { name: "slack-sync-content" } },
}))

import { enqueueSlackFullSyncAfterConfigPush } from "./enqueue-slack-push-sync.js"

describe("enqueueSlackFullSyncAfterConfigPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markInitialSyncMock.mockResolvedValue(undefined)
    markFailedMock.mockResolvedValue(undefined)
    runWorkflowMock.mockResolvedValue(undefined)
  })

  it("marks setup failed when the workflow cannot be enqueued", async () => {
    const enqueueError = new Error("OpenWorkflow unavailable")
    runWorkflowMock.mockRejectedValue(enqueueError)
    const log = { error: vi.fn() }

    await expect(
      enqueueSlackFullSyncAfterConfigPush({
        orgId: "org_1",
        connectionId: "con_1",
        log,
      }),
    ).rejects.toBe(enqueueError)

    expect(markInitialSyncMock).toHaveBeenCalledWith({
      connectionId: "con_1",
    })
    expect(markFailedMock).toHaveBeenCalledWith({ connectionId: "con_1" })
    expect(log.error).toHaveBeenCalledWith(enqueueError)
  })

  it("does not mark setup failed after a successful enqueue", async () => {
    await enqueueSlackFullSyncAfterConfigPush({
      orgId: "org_1",
      connectionId: "con_1",
      log: { error: vi.fn() },
    })

    expect(markFailedMock).not.toHaveBeenCalled()
  })
})
