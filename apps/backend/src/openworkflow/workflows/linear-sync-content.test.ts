import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeTarget: vi.fn(),
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  loadConfig: vi.fn(),
  runIngestion: vi.fn(),
  syncContent: vi.fn(),
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
  finalizeLinearBindingAfterContentWorkflow: mocks.finalizeTarget,
  getLinearConnectionByConnectionId: mocks.getConnection,
  getLinearBindingWithRepoByConnectionId: mocks.getTarget,
  refreshLinearConnectionTokensWithLock: vi.fn(),
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/linear/config-from-repo.js", () => ({
  loadLinearScopeFromRepo: mocks.loadConfig,
}))
vi.mock("../../services/linear/sync.js", () => ({
  syncLinearContentToGit: mocks.syncContent,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { linearSyncContent } from "./linear-sync-content.js"

describe("linearSyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finalizeTarget.mockResolvedValue(true)
  })

  it("marks setup failed when loading sync context fails", async () => {
    mocks.getTarget.mockRejectedValueOnce(new Error("GitHub unavailable"))
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await expect(
      linearSyncContent.fn({
        input: { orgId: "org_1", connectionId: "con_linear" },
        step,
      } as never),
    ).rejects.toThrow("GitHub unavailable")
    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_linear",
      workflowStatus: "failed",
    })
  })

  it("marks the target live after initial sync without draining events", async () => {
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      status: "installed",
    })
    mocks.loadConfig.mockResolvedValue({ workspaceId: "workspace_1" })
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      written: 1,
      deleted: 0,
      commitSha: "sha-linear",
      failures: [],
    })
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step,
    } as never)

    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_linear",
      workflowStatus: "completed",
    })
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Linear content",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged initial sync", async () => {
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      status: "installed",
    })
    mocks.loadConfig.mockResolvedValue({ workspaceId: "workspace_1" })
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      written: 0,
      deleted: 0,
      failures: [],
    })
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Linear content",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository target when a binding is rebound during replay", async () => {
    const checkpointedTarget = {
      repositoryId: "repo_original",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "linear-capture",
      enabled: true,
      setupPhase: "initial_sync",
    }
    mocks.getTarget.mockResolvedValueOnce({
      ...checkpointedTarget,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    mocks.syncContent.mockResolvedValueOnce({
      status: "completed",
      written: 0,
      deleted: 0,
      failures: [],
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-linear-sync-context") {
          return {
            connection: { id: "con_linear", status: "installed" },
            target: checkpointedTarget,
            config: { workspaceId: "workspace_1" },
          }
        }
        return operation()
      },
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step: replayStep,
    } as never)

    expect(mocks.syncContent).toHaveBeenCalledWith(
      expect.objectContaining({ target: checkpointedTarget }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "linear-capture",
      }),
      expect.any(Object),
    )
  })
})
