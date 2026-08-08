import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  listScopes: vi.fn(),
  markInitialSync: vi.fn(),
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
vi.mock("../../models/linear-connector.js", () => ({
  getLinearConnectionByConnectionId: mocks.getConnection,
  getLinearSyncTargetWithRepoByConnectionId: mocks.getTarget,
  listLinearScopesByConnectionId: mocks.listScopes,
  markLinearSyncTargetInitialSync: mocks.markInitialSync,
  updateLinearSyncTargetPrState: mocks.updatePrState,
}))
vi.mock("../../services/linear/sync.js", () => ({
  syncLinearConfigYaml: mocks.syncConfig,
}))
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("./linear-sync-content.js", () => ({
  linearSyncContent: { spec: { name: "linear-sync-content" } },
}))

import { linearSyncConfig } from "./linear-sync-config.js"

describe("linearSyncConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTarget.mockResolvedValue({
      pendingConfigPullUrl: null,
      setupPhase: "awaiting_merge",
    })
    mocks.getConnection.mockResolvedValue({ id: "con_linear" })
    mocks.listScopes.mockResolvedValue([{ externalId: "team_1" }])
    mocks.markInitialSync.mockResolvedValue(undefined)
    mocks.updatePrState.mockResolvedValue(undefined)
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
  })

  it("starts initial content sync when the repository config already matches", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })

    await linearSyncConfig.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_linear",
      },
    } as never)

    expect(mocks.markInitialSync).toHaveBeenCalledWith("con_linear")
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-content" },
      { orgId: "org_1", connectionId: "con_linear" },
    )
  })

  it("records a recoverable failure when config pull request creation fails", async () => {
    mocks.syncConfig.mockRejectedValueOnce(new Error("GitHub unavailable"))

    await expect(
      linearSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_linear",
        },
      } as never),
    ).rejects.toThrow("GitHub unavailable")
    expect(mocks.updatePrState).toHaveBeenCalledWith({
      connectionId: "con_linear",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "config_failed",
    })
  })

  it("records content sync failure when initial sync cannot be enqueued", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })
    mocks.runWorkflow.mockRejectedValueOnce(new Error("Worker unavailable"))

    await expect(
      linearSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_linear",
        },
      } as never),
    ).rejects.toThrow("Worker unavailable")
    expect(mocks.updatePrState).toHaveBeenCalledWith({
      connectionId: "con_linear",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "sync_failed",
    })
  })
})
