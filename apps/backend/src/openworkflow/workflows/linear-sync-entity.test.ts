import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  loadConfig: vi.fn(),
  runIngestion: vi.fn(),
  syncIncremental: vi.fn(),
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
  syncLinearIncrementalContent: mocks.syncIncremental,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { linearSyncEntity } from "./linear-sync-entity.js"

const step = {
  run: vi.fn(
    async (_options: { name: string }, operation: () => Promise<unknown>) =>
      operation(),
  ),
}

const input = {
  orgId: "org_1",
  connectionId: "con_linear",
  entityType: "issue" as const,
  externalId: "issue_1",
  action: "upsert" as const,
}

describe("linearSyncEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      workspaceId: "workspace_1",
      status: "installed",
    })
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "live",
    })
    mocks.loadConfig.mockResolvedValue({
      workspaceId: "workspace_1",
      workspaceName: "Acme",
      scopes: [],
    })
    mocks.syncIncremental.mockResolvedValue({
      written: 1,
      deleted: 0,
      commitSha: "sha-linear-entity",
      failures: [],
    })
    mocks.runIngestion.mockResolvedValue(undefined)
  })

  it("rejects repository config from another Linear workspace", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      workspaceId: "workspace_2",
      workspaceName: "Other",
      scopes: [],
    })

    await expect(linearSyncEntity.fn({ input, step } as never)).rejects.toThrow(
      "linear/config.yaml workspace does not match the Linear connection",
    )
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("skips an entity when the connector is no longer live", async () => {
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })

    await expect(
      linearSyncEntity.fn({ input, step } as never),
    ).resolves.toEqual({ written: 0, deleted: 0, failures: [] })
    expect(mocks.loadConfig).not.toHaveBeenCalled()
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("syncs one entity and ingests the resulting Git commit", async () => {
    await linearSyncEntity.fn({ input, step } as never)

    expect(mocks.syncIncremental).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        entity: {
          entityType: "issue",
          externalId: "issue_1",
          action: "upsert",
        },
      }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "Applying Linear updates",
        targetBranch: "main",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged entity", async () => {
    mocks.syncIncremental.mockResolvedValueOnce({
      written: 0,
      deleted: 0,
      failures: [],
    })

    await linearSyncEntity.fn({ input, step } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "Applying Linear updates",
        targetBranch: "main",
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
      setupPhase: "live",
    }
    mocks.getTarget.mockResolvedValueOnce({
      ...checkpointedTarget,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-linear-entity-context") {
          return {
            connection: {
              id: "con_linear",
              workspaceId: "workspace_1",
              status: "installed",
            },
            target: checkpointedTarget,
            config: {
              workspaceId: "workspace_1",
              workspaceName: "Acme",
              scopes: [],
            },
          }
        }
        return operation()
      },
    }

    await linearSyncEntity.fn({ input, step: replayStep } as never)

    expect(mocks.syncIncremental).toHaveBeenCalledWith(
      expect.objectContaining({ target: checkpointedTarget }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "linear-capture",
      }),
      expect.any(Object),
    )
  })

  it("fails the retryable OpenWorkflow step when the entity cannot sync", async () => {
    mocks.syncIncremental.mockResolvedValueOnce({
      written: 0,
      deleted: 0,
      failures: [
        { type: "issue", id: "issue_1", message: "Linear rate limited" },
      ],
    })

    await expect(linearSyncEntity.fn({ input, step } as never)).rejects.toThrow(
      "Linear entity sync failed",
    )
    expect(step.run).toHaveBeenCalledWith(
      {
        name: "apply-linear-entity",
        retryPolicy: {
          maximumAttempts: 5,
          initialInterval: "1m",
          backoffCoefficient: 3,
          maximumInterval: "4h",
        },
      },
      expect.any(Function),
    )
    expect(mocks.runIngestion).not.toHaveBeenCalled()
  })
})
