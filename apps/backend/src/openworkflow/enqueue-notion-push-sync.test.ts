import { beforeEach, describe, expect, it, vi } from "vitest"

const slugMock = vi.hoisted(() => vi.fn())
const markInitialSyncMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../models/notion-connector.js", () => ({
  getOrganizationSlugForNotionOrgId: slugMock,
  markNotionSyncTargetInitialSync: markInitialSyncMock,
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
    markInitialSyncMock.mockResolvedValue(undefined)
    runWorkflowMock.mockResolvedValue(undefined)
  })

  it("waits for the initial content workflow to be accepted", async () => {
    await enqueueNotionFullSyncAfterConfigPush({
      orgId: "org_1",
      connectionId: "con_1",
      scopeFromRepo: {
        resources: [{ externalId: "page_1", type: "page", title: "API" }],
      },
    })

    expect(markInitialSyncMock).toHaveBeenCalledWith({ connectionId: "con_1" })
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
        scopeFromRepo: { resources: [] },
      }),
    ).rejects.toThrow("worker unavailable")
  })
})
