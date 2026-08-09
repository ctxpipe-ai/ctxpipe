import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  closePullRequest: vi.fn(),
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  runWorkflow: vi.fn(),
  syncConfig: vi.fn(),
  transitionTarget: vi.fn(),
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
  transitionLinearSyncTargetState: mocks.transitionTarget,
}))
vi.mock("../../services/github/installation-write-client.js", () => ({
  closePullRequest: mocks.closePullRequest,
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

const scopes = [
  {
    externalId: "team_1",
    type: "team" as const,
    title: "Engineering",
    url: null,
    parentExternalId: null,
    teamId: "team_1",
    teamKey: "ENG",
  },
]

describe("linearSyncConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      pendingConfigPrCreating: true,
      pendingConfigPullUrl: null,
      setupPhase: "awaiting_merge",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      status: "installed",
    })
    mocks.transitionTarget.mockResolvedValue(true)
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
  })

  it("does not run a stale configuration workflow", async () => {
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_1",
      branch: "main",
      enabled: false,
      pendingConfigPrCreating: true,
      pendingConfigPullUrl: null,
      setupPhase: "awaiting_merge",
    })

    await expect(
      linearSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_linear",
          scopes,
        },
      } as never),
    ).rejects.toThrow("not ready for configuration sync")
    expect(mocks.syncConfig).not.toHaveBeenCalled()
    expect(mocks.transitionTarget).not.toHaveBeenCalled()
  })

  it("starts initial content sync when the repository config already matches", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })

    await linearSyncConfig.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_linear",
        scopes,
      },
    } as never)

    expect(mocks.transitionTarget).toHaveBeenCalledWith({
      connectionId: "con_linear",
      expectedSetupPhase: "awaiting_merge",
      expectedPendingConfigPrCreating: true,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "initial_sync",
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-content" },
      { orgId: "org_1", connectionId: "con_linear" },
    )
    expect(mocks.syncConfig).toHaveBeenCalledWith(
      expect.objectContaining({ scopes }),
    )
  })

  it("closes a pull request created after the target becomes stale", async () => {
    mocks.syncConfig.mockResolvedValue({
      changed: true,
      pullUrl: "https://github.com/acme/context/pull/42",
      pullNumber: 42,
    })
    mocks.transitionTarget.mockResolvedValue(false)

    await expect(
      linearSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_linear",
          scopes,
        },
      } as never),
    ).rejects.toThrow("target changed")
    expect(mocks.closePullRequest).toHaveBeenCalledWith({
      orgId: "org_1",
      env: {},
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      pullNumber: 42,
      comment:
        "Closed because the Linear connector target changed during configuration sync.",
    })
  })

  it("records a recoverable failure when config pull request creation fails", async () => {
    mocks.syncConfig.mockRejectedValueOnce(new Error("GitHub unavailable"))

    await expect(
      linearSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_linear",
          scopes,
        },
      } as never),
    ).rejects.toThrow("GitHub unavailable")
    expect(mocks.transitionTarget).toHaveBeenCalledWith({
      connectionId: "con_linear",
      expectedSetupPhase: "awaiting_merge",
      expectedPendingConfigPrCreating: true,
      repositoryId: "repo_1",
      branch: "main",
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
          scopes,
        },
      } as never),
    ).rejects.toThrow("Worker unavailable")
    expect(mocks.transitionTarget).toHaveBeenLastCalledWith({
      connectionId: "con_linear",
      expectedSetupPhase: "initial_sync",
      expectedPendingConfigPrCreating: false,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "sync_failed",
    })
  })
})
