import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeBinding: vi.fn(),
  getBinding: vi.fn(),
  getConnection: vi.fn(),
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
vi.mock("../../models/notion-connector.js", () => ({
  finalizeNotionBindingAfterContentWorkflow: mocks.finalizeBinding,
  getNotionBindingByConnectionId: mocks.getBinding,
  getNotionConnectionByConnectionId: mocks.getConnection,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/notion/sync.js", () => ({
  syncNotionContent: mocks.syncContent,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { notionSyncContent } from "./notion-sync-content.js"

const step = {
  run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
    operation(),
}

describe("notionSyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finalizeBinding.mockResolvedValue(true)
    mocks.getConnection.mockResolvedValue({
      id: "con_notion",
      accessToken: "token",
    })
    mocks.getBinding.mockResolvedValue({
      orgId: "org_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
  })

  it("marks sync_failed when loading context throws", async () => {
    mocks.getBinding.mockRejectedValueOnce(new Error("database unavailable"))

    await expect(
      notionSyncContent.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_notion",
        },
        step,
      } as never),
    ).rejects.toThrow("database unavailable")

    expect(mocks.finalizeBinding).toHaveBeenCalledWith({
      connectionId: "con_notion",
      workflowStatus: "failed",
    })
  })

  it("finalizes partial content failures as failed lifecycle", async () => {
    mocks.syncContent.mockResolvedValue({
      status: "partial_failed",
      resourcesProcessed: 1,
      resourcesFailed: 1,
      errors: [{ externalId: "page_2", message: "Not found" }],
    })

    await notionSyncContent.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_notion",
      },
      step,
    } as never)

    expect(mocks.finalizeBinding).toHaveBeenCalledWith({
      connectionId: "con_notion",
      workflowStatus: "partial_failed",
    })
  })

  it("hands a changed mirror to shared tip-aware ingestion", async () => {
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      resourcesProcessed: 1,
      resourcesFailed: 0,
      commitSha: "sha-notion",
      errors: [],
    })

    await notionSyncContent.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_notion",
      },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Notion content",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged mirror", async () => {
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      resourcesProcessed: 1,
      resourcesFailed: 0,
      errors: [],
    })

    await notionSyncContent.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_notion",
      },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Notion content",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository target when a binding is rebound during replay", async () => {
    const checkpointedBinding = {
      orgId: "org_1",
      repositoryId: "repo_original",
      branch: "notion-capture",
      enabled: true,
      setupPhase: "initial_sync",
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
        if (options.name === "load-notion-sync-context") {
          return {
            connection: { id: "con_notion", accessToken: "token" },
            binding: checkpointedBinding,
          }
        }
        return operation()
      },
    }

    await notionSyncContent.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_notion",
      },
      step: replayStep,
    } as never)

    expect(mocks.syncContent).toHaveBeenCalledWith(
      expect.objectContaining({ binding: checkpointedBinding }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "notion-capture",
      }),
      expect.any(Object),
    )
  })
})
