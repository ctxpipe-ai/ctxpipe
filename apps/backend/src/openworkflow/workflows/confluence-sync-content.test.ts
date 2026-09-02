import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeTarget: vi.fn(),
  getInstallation: vi.fn(),
  getTarget: vi.fn(),
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
vi.mock("../../models/atlassian-connector.js", () => ({
  getForgeInstallationByConnectionId: mocks.getInstallation,
}))
vi.mock("../../models/confluence-sync-target.js", () => ({
  finalizeConfluenceSyncTargetAfterContentWorkflow: mocks.finalizeTarget,
  getConfluenceSyncTargetByConnectionId: mocks.getTarget,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/confluence/sync.js", () => ({
  syncConfluenceContent: mocks.syncContent,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { confluenceSyncContent } from "./confluence-sync-content.js"

const step = {
  run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
    operation(),
}

describe("confluenceSyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getInstallation.mockResolvedValue({
      id: "con_forge",
      cloudId: "cloud-1",
      atlassianApiBaseUrl: null,
      appSystemToken: "token",
    })
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
    })
    mocks.syncContent.mockResolvedValue({
      status: "completed",
      spacesProcessed: 1,
      pagesProcessed: 1,
      pagesFailed: 0,
      commitSha: "sha-1",
      errors: [],
    })
    mocks.finalizeTarget.mockResolvedValue(undefined)
    mocks.runIngestion.mockResolvedValue(undefined)
  })

  it("ingests the bound repository after Confluence content changes", async () => {
    await confluenceSyncContent.fn({
      input: { orgId: "org_1", orgSlug: "acme", connectionId: "con_forge" },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Confluence content",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying unchanged Confluence writes", async () => {
    mocks.syncContent.mockResolvedValueOnce({
      status: "completed",
      spacesProcessed: 1,
      pagesProcessed: 1,
      pagesFailed: 0,
      errors: [],
    })

    await confluenceSyncContent.fn({
      input: { orgId: "org_1", orgSlug: "acme", connectionId: "con_forge" },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Confluence content",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository target when a binding is rebound during replay", async () => {
    const checkpointedTarget = {
      repositoryId: "repo_original",
      branch: "confluence-capture",
      enabled: true,
    }
    mocks.getTarget.mockResolvedValueOnce({
      repositoryId: "repo_rebound",
      branch: "main",
      enabled: true,
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-confluence-sync-context") {
          return {
            installation: {
              id: "con_forge",
              cloudId: "cloud-1",
              atlassianApiBaseUrl: null,
              appSystemToken: "token",
            },
            target: checkpointedTarget,
          }
        }
        return operation()
      },
    }

    await confluenceSyncContent.fn({
      input: { orgId: "org_1", orgSlug: "acme", connectionId: "con_forge" },
      step: replayStep,
    } as never)

    expect(mocks.syncContent).toHaveBeenCalledWith(
      expect.objectContaining({ target: checkpointedTarget }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "confluence-capture",
      }),
      expect.any(Object),
    )
  })
})
