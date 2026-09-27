import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTarget: vi.fn(),
  activate: vi.fn(),
  captureBinding: vi.fn(),
  assertBinding: vi.fn(),
  enqueueContent: vi.fn(),
  syncConfig: vi.fn(),
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
vi.mock("../../models/confluence-sync-target.js", () => ({
  getConfluenceSyncTargetWithRepoByConnectionId: mocks.getTarget,
  updateConfluenceSyncTargetPrState: mocks.updatePrState,
}))
vi.mock("../../models/connector-content-sync.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../models/connector-content-sync.js")
    >()
  return {
    ...actual,
    activateConnectorSync: mocks.activate,
    assertConnectorContentSyncBinding: mocks.assertBinding,
    captureConnectorConfigSyncBinding: mocks.captureBinding,
  }
})
vi.mock("../../services/confluence/sync.js", () => ({
  syncConfluenceConfigYaml: mocks.syncConfig,
}))
vi.mock("../enqueue-connector-content-sync.js", () => ({
  enqueueConnectorContentSync: mocks.enqueueContent,
}))

import { confluenceSyncConfig } from "./confluence-sync-config.js"

const contentSyncBinding = {
  provider: "confluence" as const,
  repositoryId: "repo_1",
  branch: "main",
  workspaceId: null,
  cloudId: "cloud_1",
  atlassianApiBaseUrl: null,
}

describe("confluenceSyncConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTarget.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_forge",
      repositoryId: "repo_1",
      repositoryName: "fixture/hydration-contract",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "awaiting_merge",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: true,
    })
    mocks.activate.mockResolvedValue(true)
    mocks.captureBinding.mockResolvedValue(contentSyncBinding)
    mocks.assertBinding.mockResolvedValue(undefined)
    mocks.updatePrState.mockResolvedValue(undefined)
    mocks.enqueueContent.mockResolvedValue(true)
  })

  it("starts initial content sync when the repository config is unchanged", async () => {
    mocks.syncConfig.mockResolvedValue({ changed: false })

    await confluenceSyncConfig.fn({
      input: {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_forge",
        contentSyncGeneration: 1,
        contentSyncBinding,
      },
      run: { id: "run_1" },
      step: {
        run: (_name: unknown, fn: () => unknown) => fn(),
      },
    } as never)

    expect(mocks.enqueueContent).toHaveBeenCalledWith({
      orgId: "org_1",
      orgSlug: "acme",
      connectionId: "con_forge",
      provider: "confluence",
      repositoryId: "repo_1",
      branch: "main",
      configKey: "config-workflow:run_1",
    })
  })
})
