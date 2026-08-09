import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeTarget: vi.fn(),
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  loadConfig: vi.fn(),
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
  runRepositoryIngestionWorkflow: vi.fn(),
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
  })
})
