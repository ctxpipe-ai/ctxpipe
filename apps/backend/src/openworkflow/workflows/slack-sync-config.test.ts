import { beforeEach, describe, expect, it, vi } from "vitest"

const getConnectionMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())
const markLiveMock = vi.hoisted(() => vi.fn())
const updatePrStateMock = vi.hoisted(() => vi.fn())
const syncConfigMock = vi.hoisted(() => vi.fn())
const enqueueContentMock = vi.hoisted(() => vi.fn())

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    definition: { name: string },
    run: (context: unknown) => Promise<unknown>,
  ) => ({
    spec: definition,
    run,
  }),
}))
vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/slack-connector.js", () => ({
  getSlackConnectionByConnectionId: getConnectionMock,
  getSlackSyncTargetByConnectionId: getTargetMock,
  markSlackSyncTargetLive: markLiveMock,
  updateSlackSyncTargetPrState: updatePrStateMock,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn() }),
}))
vi.mock("../../services/slack/sync.js", () => ({
  syncSlackConfigYaml: syncConfigMock,
}))
vi.mock("../enqueue-slack-push-sync.js", () => ({
  enqueueSlackFullSyncAfterConfigPush: enqueueContentMock,
}))

import { slackSyncConfig } from "./slack-sync-config.js"

async function runWorkflow() {
  return (
    slackSyncConfig as unknown as {
      run: (context: {
        input: { orgId: string; orgSlug: string; connectionId: string }
      }) => Promise<unknown>
    }
  ).run({
    input: {
      orgId: "org_1",
      orgSlug: "acme",
      connectionId: "con_1",
    },
  })
}

describe("slackSyncConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConnectionMock.mockResolvedValue({ id: "con_1", orgId: "org_1" })
    getTargetMock
      .mockResolvedValueOnce({
        connectionId: "con_1",
        orgId: "org_1",
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: null,
      })
      .mockResolvedValueOnce({
        connectionId: "con_1",
        orgId: "org_1",
        setupPhase: "sync_failed",
        pendingConfigPullUrl: null,
      })
    syncConfigMock.mockResolvedValue({ changed: false })
    updatePrStateMock.mockResolvedValue(undefined)
  })

  it("preserves sync_failed when content workflow enqueue fails", async () => {
    const enqueueError = new Error("OpenWorkflow unavailable")
    enqueueContentMock.mockRejectedValue(enqueueError)

    await expect(runWorkflow()).rejects.toBe(enqueueError)

    expect(updatePrStateMock).not.toHaveBeenCalled()
  })
})
