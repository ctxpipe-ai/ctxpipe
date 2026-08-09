import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeTarget: vi.fn(),
  getConnection: vi.fn(),
  getTarget: vi.fn(),
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
  finalizeNotionSyncTargetAfterContentWorkflow: mocks.finalizeTarget,
  getNotionConnectionByConnectionId: mocks.getConnection,
  getNotionSyncTargetByConnectionId: mocks.getTarget,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
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
    mocks.finalizeTarget.mockResolvedValue(true)
    mocks.getConnection.mockResolvedValue({
      id: "con_notion",
      accessToken: "token",
    })
    mocks.getTarget.mockResolvedValue({
      orgId: "org_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
  })

  it("marks sync_failed when loading context throws", async () => {
    mocks.getTarget.mockRejectedValueOnce(new Error("database unavailable"))

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

    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
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

    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_notion",
      workflowStatus: "partial_failed",
    })
  })
})
