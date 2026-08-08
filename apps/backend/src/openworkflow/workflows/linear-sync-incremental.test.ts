import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  clearDirty: vi.fn(),
  deadLetterDirty: vi.fn(),
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  listDirty: vi.fn(),
  loadConfig: vi.fn(),
  runWorkflow: vi.fn(),
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
  clearLinearDirtyEntities: mocks.clearDirty,
  deadLetterLinearDirtyEntities: mocks.deadLetterDirty,
  getLinearConnectionByConnectionId: mocks.getConnection,
  getLinearSyncTargetWithRepoByConnectionId: mocks.getTarget,
  listLinearDirtyEntities: mocks.listDirty,
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
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runRepositoryIngestionWorkflow: vi.fn(),
}))

import { linearSyncIncremental } from "./linear-sync-incremental.js"

const step = {
  run: async (_options: { name: string }, operation: () => Promise<unknown>) =>
    operation(),
}

describe("linearSyncIncremental", () => {
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
    mocks.listDirty.mockResolvedValue([
      {
        id: "dirty_1",
        entityType: "issue",
        externalId: "issue_1",
        revision: 1,
      },
    ])
    mocks.loadConfig.mockResolvedValue({
      workspaceId: "workspace_1",
      workspaceName: "Acme",
      scopes: [],
    })
    mocks.clearDirty.mockResolvedValue(undefined)
    mocks.deadLetterDirty.mockResolvedValue(undefined)
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
  })

  it("rejects repository config from another Linear workspace", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      workspaceId: "workspace_2",
      workspaceName: "Other",
      scopes: [],
    })

    await expect(
      linearSyncIncremental.fn({
        input: {
          orgId: "org_1",
          connectionId: "con_linear",
          retryAttempt: 0,
        },
        step,
      } as never),
    ).rejects.toThrow(
      "linear/config.yaml workspace does not match the Linear connection",
    )
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("does not apply queued updates before the connector is live", async () => {
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "awaiting_merge",
    })

    const result = await linearSyncIncremental.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_linear",
        retryAttempt: 0,
      },
      step,
    } as never)

    expect(result).toEqual({ written: 0, deleted: 0, failures: [] })
    expect(mocks.loadConfig).not.toHaveBeenCalled()
    expect(mocks.syncIncremental).not.toHaveBeenCalled()
  })

  it("automatically retries transient entity failures with backoff", async () => {
    mocks.syncIncremental.mockResolvedValue({
      written: 0,
      deleted: 0,
      failures: [{ type: "issue", id: "issue_1", error: "rate limited" }],
    })

    await linearSyncIncremental.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_linear",
        retryAttempt: 0,
      },
      step,
    } as never)

    expect(mocks.clearDirty).toHaveBeenCalledWith([])
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "linear-sync-incremental" }),
      {
        orgId: "org_1",
        connectionId: "con_linear",
        retryAttempt: 1,
      },
      { availableAt: "1m" },
    )
  })

  it("dead-letters exhausted rows and continues past a poisoned full batch", async () => {
    const dirty = Array.from({ length: 100 }, (_, index) => ({
      id: `dirty_${index}`,
      entityType: "issue",
      externalId: `issue_${index}`,
      revision: 1,
    }))
    mocks.listDirty.mockResolvedValueOnce(dirty)
    mocks.syncIncremental.mockResolvedValue({
      written: 0,
      deleted: 0,
      failures: dirty.map((row) => ({
        type: row.entityType,
        id: row.externalId,
        error: "rate limited",
      })),
    })

    await linearSyncIncremental.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_linear",
        retryAttempt: 5,
      },
      step,
    } as never)

    expect(mocks.clearDirty).toHaveBeenCalledWith([])
    expect(mocks.deadLetterDirty).toHaveBeenCalledWith(
      dirty.map((row) => ({ id: row.id, revision: row.revision })),
    )
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "linear-sync-incremental" }),
      {
        orgId: "org_1",
        connectionId: "con_linear",
        retryAttempt: 0,
      },
      undefined,
    )
  })
})
