import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  getConnection: vi.fn(),
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
vi.mock("../../models/notion-connector.js", () => ({
  getNotionBindingWithRepoByConnectionId: mocks.getBinding,
  getNotionConnectionByConnectionId: mocks.getConnection,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/notion/config-from-repo.js", () => ({
  loadNotionScopeFromRepo: mocks.loadConfig,
}))
vi.mock("../../services/notion/sync.js", () => ({
  syncNotionIncrementalContent: mocks.syncIncremental,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { notionSyncEntity } from "./notion-sync-entity.js"

const step = {
  run: vi.fn(
    async (_options: { name: string }, operation: () => Promise<unknown>) =>
      operation(),
  ),
}

const input = {
  orgId: "org_1",
  connectionId: "con_notion",
  entityType: "page" as const,
  externalId: "page_1",
  action: "upsert" as const,
}

describe("notionSyncEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnection.mockResolvedValue({
      id: "con_notion",
      status: "installed",
      accessToken: "tok",
    })
    mocks.getBinding.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "live",
    })
    mocks.loadConfig.mockResolvedValue({ resources: [] })
    mocks.syncIncremental.mockResolvedValue({
      status: "completed",
      written: 1,
      deleted: 0,
      commitSha: "sha-notion-entity",
      errors: [],
    })
    mocks.runIngestion.mockResolvedValue(undefined)
  })

  it("skips an entity when the connector is no longer live", async () => {
    mocks.getBinding.mockResolvedValueOnce({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })

    await expect(
      notionSyncEntity.fn({ input, step } as never),
    ).resolves.toEqual({ written: 0, deleted: 0, errors: [] })
    expect(mocks.loadConfig).not.toHaveBeenCalled()
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("throws when the repository scope config is missing", async () => {
    mocks.loadConfig.mockResolvedValueOnce(undefined)

    await expect(notionSyncEntity.fn({ input, step } as never)).rejects.toThrow(
      "notion/config.yaml",
    )
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("syncs one entity and ingests the resulting Git commit", async () => {
    await notionSyncEntity.fn({ input, step } as never)

    expect(mocks.syncIncremental).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        entity: {
          entityType: "page",
          externalId: "page_1",
          action: "upsert",
        },
      }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "Applying Notion updates",
        targetBranch: "main",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged entity", async () => {
    mocks.syncIncremental.mockResolvedValueOnce({
      status: "completed",
      written: 0,
      deleted: 0,
      errors: [],
    })

    await notionSyncEntity.fn({ input, step } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "Applying Notion updates",
        targetBranch: "main",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository target when a binding is rebound during replay", async () => {
    const checkpointedBinding = {
      repositoryId: "repo_original",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "notion-capture",
      enabled: true,
      setupPhase: "live",
    }
    mocks.getBinding.mockResolvedValueOnce({
      ...checkpointedBinding,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-notion-entity-context") {
          return {
            connection: {
              id: "con_notion",
              status: "installed",
              accessToken: "tok",
            },
            binding: checkpointedBinding,
            config: { resources: [] },
          }
        }
        return operation()
      },
    }

    await notionSyncEntity.fn({ input, step: replayStep } as never)

    expect(mocks.syncIncremental).toHaveBeenCalledWith(
      expect.objectContaining({ binding: checkpointedBinding }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "notion-capture",
      }),
      expect.any(Object),
    )
  })

  it("fails the retryable OpenWorkflow step when the entity cannot sync", async () => {
    mocks.syncIncremental.mockResolvedValueOnce({
      status: "failed",
      written: 0,
      deleted: 0,
      errors: [{ externalId: "page_1", message: "Notion rate limited" }],
    })

    await expect(notionSyncEntity.fn({ input, step } as never)).rejects.toThrow(
      "Notion entity sync failed",
    )
    expect(step.run).toHaveBeenCalledWith(
      {
        name: "apply-notion-entity",
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
