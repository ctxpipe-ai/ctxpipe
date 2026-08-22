import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeBinding: vi.fn(),
  getBinding: vi.fn(),
  getConnection: vi.fn(),
  syncContent: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  withOrgDbContext: vi.fn((_orgId: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}))
vi.mock("../../models/notion-connector.js", () => ({
  finalizeNotionBindingAfterContentWorkflow: mocks.finalizeBinding,
  getNotionBindingByConnectionId: mocks.getBinding,
  getNotionConnectionByConnectionId: mocks.getConnection,
}))
vi.mock("../../services/notion/sync.js", () => ({
  syncNotionContent: mocks.syncContent,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runRepositoryIngestionWorkflow: vi.fn(),
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
})
