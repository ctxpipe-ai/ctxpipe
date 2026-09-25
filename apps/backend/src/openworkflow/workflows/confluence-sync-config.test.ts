import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTarget: vi.fn(),
  markInitialSync: vi.fn(),
  markLive: vi.fn(),
  runWorkflow: vi.fn(),
  syncConfig: vi.fn(),
  updatePrState: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}))
vi.mock("../../models/confluence-sync-target.js", () => ({
  getConfluenceSyncTargetByConnectionId: mocks.getTarget,
  markConfluenceSyncTargetInitialSync: mocks.markInitialSync,
  markConfluenceSyncTargetLive: mocks.markLive,
  updateConfluenceSyncTargetPrState: mocks.updatePrState,
}))
vi.mock("../../services/confluence/sync.js", () => ({
  syncConfluenceConfigYaml: mocks.syncConfig,
}))
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("./confluence-sync-content.js", () => ({
  confluenceSyncContent: { spec: { name: "confluence-sync-content" } },
}))

import { confluenceSyncConfig } from "./confluence-sync-config.js"

describe("confluenceSyncConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTarget.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_forge",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase: "awaiting_merge",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: true,
    })
    mocks.markInitialSync.mockResolvedValue(undefined)
    mocks.markLive.mockResolvedValue(undefined)
    mocks.updatePrState.mockResolvedValue(undefined)
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
  })

  it("starts initial content sync when the repository config is unchanged", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })

    await confluenceSyncConfig.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_forge",
      },
      step: {},
    } as never)

    expect(mocks.markLive).not.toHaveBeenCalled()
    expect(mocks.markInitialSync).toHaveBeenCalledWith({
      connectionId: "con_forge",
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "confluence-sync-content" },
      {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_forge",
      },
    )
  })
})
