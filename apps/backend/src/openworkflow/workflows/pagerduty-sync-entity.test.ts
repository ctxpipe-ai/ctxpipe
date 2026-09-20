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
vi.mock("../../models/pagerduty-connector.js", () => ({
  getPagerdutyConnectionByConnectionId: mocks.getConnection,
  getPagerdutyBindingWithRepoByConnectionId: mocks.getTarget,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/pagerduty/config-from-repo.js", () => ({
  loadPagerdutyScopeFromRepo: mocks.loadConfig,
}))
vi.mock("../../services/pagerduty/sync.js", () => ({
  syncPagerdutyIncrementalContent: mocks.syncIncremental,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { pagerdutySyncEntity } from "./pagerduty-sync-entity.js"

const step = {
  run: vi.fn(
    async (_options: { name: string }, operation: () => Promise<unknown>) =>
      operation(),
  ),
  runWorkflow: vi.fn(),
}

const input = {
  orgId: "org_1",
  connectionId: "con_pd",
  incidentId: "PINCIDENT",
}

describe("pagerdutySyncEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnection.mockResolvedValue({
      id: "con_pd",
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
      services: [{ id: "PSERVICE", name: "checkout" }],
    })
    mocks.syncIncremental.mockResolvedValue({
      written: 1,
      deleted: 0,
      commitSha: "sha-pd-entity",
      errors: [],
    })
    mocks.runIngestion.mockResolvedValue(undefined)
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
      pagerdutySyncEntity.fn({ input, step } as never),
    ).resolves.toEqual({ written: 0, deleted: 0, errors: [] })
    expect(mocks.loadConfig).not.toHaveBeenCalled()
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("syncs one incident and ingests the resulting Git commit", async () => {
    await pagerdutySyncEntity.fn({ input, step } as never)

    expect(mocks.syncIncremental).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        entity: { incidentId: "PINCIDENT" },
      }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      step,
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Applying PagerDuty updates",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged entity", async () => {
    mocks.syncIncremental.mockResolvedValueOnce({
      written: 0,
      deleted: 0,
      errors: [],
    })

    await pagerdutySyncEntity.fn({ input, step } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "Applying PagerDuty updates",
        targetBranch: "main",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository binding when rebound during replay", async () => {
    const checkpointedBinding = {
      repositoryId: "repo_original",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "pagerduty-capture",
      enabled: true,
      setupPhase: "live",
    }
    mocks.getTarget.mockResolvedValueOnce({
      ...checkpointedBinding,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-pagerduty-entity-context") {
          return {
            connection: { id: "con_pd", status: "installed" },
            binding: checkpointedBinding,
            config: { services: [{ id: "PSERVICE", name: "checkout" }] },
          }
        }
        return operation()
      },
    }

    await pagerdutySyncEntity.fn({ input, step: replayStep } as never)

    expect(mocks.syncIncremental).toHaveBeenCalledWith(
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

  it("fails the retryable OpenWorkflow step when the entity cannot sync", async () => {
    mocks.syncIncremental.mockResolvedValueOnce({
      status: "failed",
      written: 0,
      deleted: 0,
      errors: [{ externalId: "PINCIDENT", message: "PagerDuty rate limited" }],
    })

    await expect(
      pagerdutySyncEntity.fn({ input, step } as never),
    ).rejects.toThrow("PagerDuty entity sync failed")
    expect(step.run).toHaveBeenCalledWith(
      {
        name: "apply-pagerduty-entity",
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
