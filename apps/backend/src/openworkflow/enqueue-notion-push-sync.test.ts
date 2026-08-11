import { beforeEach, describe, expect, it, vi } from "vitest"

const slugMock = vi.hoisted(() => vi.fn())
const claimInitialSyncMock = vi.hoisted(() => vi.fn())
const transitionBindingMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../models/notion-connector.js", () => ({
  claimNotionBindingInitialSync: claimInitialSyncMock,
  getOrganizationSlugForNotionOrgId: slugMock,
  transitionNotionBindingState: transitionBindingMock,
}))
vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("./workflows/notion-sync-content.js", () => ({
  notionSyncContent: { spec: { name: "notion-sync-content" } },
}))

import { enqueueNotionFullSyncAfterConfigPush } from "./enqueue-notion-push-sync.js"

describe("enqueueNotionFullSyncAfterConfigPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    slugMock.mockResolvedValue("acme")
    claimInitialSyncMock.mockResolvedValue(true)
    transitionBindingMock.mockResolvedValue(true)
    runWorkflowMock.mockResolvedValue(undefined)
  })

  it("waits for the initial content workflow to be accepted", async () => {
    await enqueueNotionFullSyncAfterConfigPush({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
      branch: "main",
      scopeFromRepo: {
        resources: [{ externalId: "page_1", type: "page", title: "API" }],
      },
    })

    expect(claimInitialSyncMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      repositoryId: "repo_1",
      branch: "main",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-content" },
      {
        orgId: "org_1",
        orgSlug: "acme",
        connectionId: "con_1",
        scopeFromRepo: {
          resources: [{ externalId: "page_1", type: "page", title: "API" }],
        },
      },
    )
  })

  it("propagates enqueue failures so GitHub retries the webhook", async () => {
    runWorkflowMock.mockRejectedValueOnce(new Error("worker unavailable"))

    await expect(
      enqueueNotionFullSyncAfterConfigPush({
        orgId: "org_1",
        connectionId: "con_1",
        repositoryId: "repo_1",
        branch: "main",
        scopeFromRepo: { resources: [] },
      }),
    ).rejects.toThrow("worker unavailable")
    expect(transitionBindingMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      expectedSetupPhase: "initial_sync",
      expectedPendingConfigPrCreating: false,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "awaiting_merge",
    })
  })

  it("does not enqueue when another activation already claimed the binding", async () => {
    claimInitialSyncMock.mockResolvedValueOnce(false)

    await enqueueNotionFullSyncAfterConfigPush({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
      branch: "main",
      scopeFromRepo: { resources: [] },
    })

    expect(runWorkflowMock).not.toHaveBeenCalled()
  })
})
