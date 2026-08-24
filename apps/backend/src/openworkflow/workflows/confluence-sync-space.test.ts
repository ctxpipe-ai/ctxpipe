import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
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
  getConfluenceSyncTargetByConnectionId: mocks.getTarget,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/confluence/sync.js", () => ({
  syncConfluenceContent: mocks.syncContent,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { confluenceSyncSpace } from "./confluence-sync-space.js"

describe("confluenceSyncSpace", () => {
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
    mocks.runIngestion.mockResolvedValue(undefined)
  })

  it("ingests the bound repository after a changed page write", async () => {
    await confluenceSyncSpace.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_forge",
        spaceKey: "ENG",
        pageId: "42",
        eventType: "avi:confluence:updated:page",
      },
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Applying Confluence updates",
      },
      expect.any(Object),
    )
  })

  it("does not ingest when the page write did not change", async () => {
    mocks.syncContent.mockResolvedValueOnce({
      status: "completed",
      spacesProcessed: 1,
      pagesProcessed: 1,
      pagesFailed: 0,
      errors: [],
    })

    await confluenceSyncSpace.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_forge",
        spaceKey: "ENG",
        pageId: "42",
      },
    } as never)

    expect(mocks.runIngestion).not.toHaveBeenCalled()
  })
})
