import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTarget: vi.fn(),
  updatePrState: vi.fn(),
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
  getLinearConnectionByConnectionId: vi.fn(),
  getLinearSyncTargetWithRepoByConnectionId: mocks.getTarget,
  markLinearSyncTargetLive: vi.fn(),
  updateLinearConnectionTokens: vi.fn(),
  updateLinearSyncTargetPrState: mocks.updatePrState,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/linear/config-from-repo.js", () => ({
  loadLinearScopeFromRepo: vi.fn(),
}))
vi.mock("../../services/linear/sync.js", () => ({
  syncLinearContentToGit: vi.fn(),
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runRepositoryIngestionWorkflow: vi.fn(),
}))

import { linearSyncContent } from "./linear-sync-content.js"

describe("linearSyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updatePrState.mockResolvedValue(undefined)
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
    expect(mocks.updatePrState).toHaveBeenCalledWith({
      connectionId: "con_linear",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "sync_failed",
    })
  })
})
