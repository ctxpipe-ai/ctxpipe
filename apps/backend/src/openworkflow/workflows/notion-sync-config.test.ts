import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  runWorkflow: vi.fn(),
  syncConfig: vi.fn(),
  transitionBinding: vi.fn(),
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
  getNotionBindingByConnectionId: mocks.getBinding,
  transitionNotionBindingState: mocks.transitionBinding,
}))
vi.mock("../../services/notion/sync.js", () => ({
  syncNotionConfigYaml: mocks.syncConfig,
}))
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("./notion-sync-content.js", () => ({
  notionSyncContent: { spec: { name: "notion-sync-content" } },
}))

import { notionSyncConfig } from "./notion-sync-config.js"

const resources = [
  {
    externalId: "page_1",
    type: "page" as const,
    title: "API",
  },
]

const step = {
  run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
    operation(),
}

describe("notionSyncConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBinding.mockResolvedValue({
      orgId: "org_1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      pendingConfigPrCreating: true,
      pendingConfigPullUrl: null,
      setupPhase: "awaiting_merge",
    })
    mocks.transitionBinding.mockResolvedValue(true)
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
  })

  it("starts initial content sync when the repository config is unchanged", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })

    await notionSyncConfig.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_notion",
        resources,
      },
      step,
    } as never)

    expect(mocks.transitionBinding).toHaveBeenCalledWith({
      connectionId: "con_notion",
      expectedSetupPhase: "awaiting_merge",
      expectedPendingConfigPrCreating: true,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "initial_sync",
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "notion-sync-content" },
      {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_notion",
      },
    )
  })

  it("records config_failed when configuration sync throws", async () => {
    mocks.syncConfig.mockRejectedValueOnce(new Error("GitHub unavailable"))

    await expect(
      notionSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_notion",
          resources,
        },
        step,
      } as never),
    ).rejects.toThrow("GitHub unavailable")

    expect(mocks.transitionBinding).toHaveBeenCalledWith({
      connectionId: "con_notion",
      expectedSetupPhase: "awaiting_merge",
      expectedPendingConfigPrCreating: true,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "config_failed",
    })
  })

  it("records config_failed when initial content sync cannot be enqueued", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })
    mocks.runWorkflow.mockRejectedValueOnce(new Error("worker unavailable"))

    await expect(
      notionSyncConfig.fn({
        input: {
          orgId: "org_1",
          orgSlug: "acme",
          connectionId: "con_notion",
          resources,
        },
        step,
      } as never),
    ).rejects.toThrow("worker unavailable")

    expect(mocks.transitionBinding).toHaveBeenLastCalledWith({
      connectionId: "con_notion",
      expectedSetupPhase: "initial_sync",
      expectedPendingConfigPrCreating: false,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "config_failed",
    })
  })
})
