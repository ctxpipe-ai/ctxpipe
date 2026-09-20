import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeTarget: vi.fn(),
  getConnection: vi.fn(),
  getBinding: vi.fn(),
  syncContent: vi.fn(),
  runIngestion: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}))
vi.mock("../../models/pagerduty-connector.js", () => ({
  finalizePagerdutyBindingAfterContentWorkflow: mocks.finalizeTarget,
  getPagerdutyConnectionByConnectionId: mocks.getConnection,
  getPagerdutyBindingByConnectionId: mocks.getBinding,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/pagerduty/sync.js", () => ({
  syncPagerdutyContent: mocks.syncContent,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { pagerdutySyncContent } from "./pagerduty-sync-content.js"

describe("pagerdutySyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finalizeTarget.mockResolvedValue(true)
  })

  it("marks setup failed when loading sync context fails", async () => {
    mocks.getBinding.mockRejectedValueOnce(new Error("GitHub unavailable"))
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await expect(
      pagerdutySyncContent.fn({
        input: { orgId: "org_1", connectionId: "con_pd" },
        step,
      } as never),
    ).rejects.toThrow("GitHub unavailable")
    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_pd",
      workflowStatus: "failed",
    })
  })

  it("marks the binding live after initial sync and ingests the write", async () => {
    mocks.getBinding.mockResolvedValue({
      orgId: "org_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
      status: "installed",
    })
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      resourcesProcessed: 1,
      resourcesFailed: 0,
      commitSha: "sha-pd",
      errors: [],
    })
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await pagerdutySyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_pd" },
      step,
    } as never)

    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_pd",
      workflowStatus: "completed",
    })
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing PagerDuty content",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged initial sync", async () => {
    mocks.getBinding.mockResolvedValue({
      orgId: "org_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
      status: "installed",
    })
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      resourcesProcessed: 0,
      resourcesFailed: 0,
      errors: [],
    })
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await pagerdutySyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_pd" },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing PagerDuty content",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository binding when rebound during replay", async () => {
    const checkpointedBinding = {
      orgId: "org_1",
      repositoryId: "repo_original",
      branch: "pagerduty-capture",
      enabled: true,
      setupPhase: "initial_sync" as const,
    }
    mocks.getBinding.mockResolvedValueOnce({
      ...checkpointedBinding,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    mocks.syncContent.mockResolvedValueOnce({
      status: "completed",
      resourcesProcessed: 0,
      resourcesFailed: 0,
      errors: [],
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-pagerduty-sync-context") {
          return {
            connection: { id: "con_pd", status: "installed" },
            binding: checkpointedBinding,
          }
        }
        return operation()
      },
    }

    await pagerdutySyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_pd" },
      step: replayStep,
    } as never)

    expect(mocks.syncContent).toHaveBeenCalledWith(
      expect.objectContaining({ binding: checkpointedBinding }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "pagerduty-capture",
      }),
      expect.any(Object),
    )
  })
})
