import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const claimNotionConfigPrCreationMock = vi.hoisted(() => vi.fn())
const patchNotionConnectorConfigMock = vi.hoisted(() => vi.fn())
const resolveNotionConnectionForOrgDetailedMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/notion-connector.js", () => ({
  claimNotionConfigPrCreation: claimNotionConfigPrCreationMock,
  deleteNotionConnectionById: vi.fn(),
  getNotionSyncTargetWithRepoByConnectionId: vi.fn(),
  listNotionResourcesByConnectionId: vi.fn(),
  MULTIPLE_NOTION_CONNECTIONS_MESSAGE:
    "Multiple Notion connections for this organization; specify connectionId query parameter",
  patchNotionConnectorConfig: patchNotionConnectorConfigMock,
  resolveNotionConnectionForOrgDetailed:
    resolveNotionConnectionForOrgDetailedMock,
  updateNotionConnectionTokens: vi.fn(),
  upsertNotionConnectionFromOAuth: vi.fn(),
}))

vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: vi.fn(),
}))

vi.mock("../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: (...args: unknown[]) => runWorkflowMock(...args),
}))

vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: vi.fn(),
}))

vi.mock("../../openworkflow/workflows/notion-sync-config.js", () => ({
  notionSyncConfig: { spec: { name: "notion-sync-config" } },
}))

vi.mock("../../services/notion/client.js", () => ({
  exchangeNotionOAuthCode: vi.fn(),
  getNotionOAuthAuthorizeUrl: vi.fn(),
  searchNotionResources: vi.fn(),
}))

vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
  }),
}))

import { notionConnectorRoutes } from "./connectors-notion.js"

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/:orgSlug/api/v1/connectors/notion", notionConnectorRoutes)
  return app
}

const resource = {
  id: "nr_1",
  connectionId: "con_1",
  externalId: "page_1",
  type: "page" as const,
  title: "API",
  url: null,
  parentExternalId: null,
  lastSyncedAt: null,
  createdAt: new Date("2026-07-31T00:00:00.000Z"),
  updatedAt: new Date("2026-07-31T00:00:00.000Z"),
}

describe("Notion connector config", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveNotionConnectionForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      connection: {
        id: "con_1",
        orgId: "org_1",
        status: "installed",
        accessToken: "notion_token",
      },
    })
    patchNotionConnectorConfigMock.mockResolvedValue({
      resources: [resource],
      resourcesChanged: true,
      syncTargetChanged: false,
    })
    claimNotionConfigPrCreationMock.mockResolvedValue(true)
    runWorkflowMock.mockResolvedValue({ status: "running" })
  })

  it("enqueues only once when overlapping saves both report a change", async () => {
    claimNotionConfigPrCreationMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const app = createApp()
    const request = () =>
      app.request("/demo/api/v1/connectors/notion/config?connectionId=con_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resources: [
            {
              externalId: "page_1",
              type: "page",
              title: "API",
            },
          ],
        }),
      })

    const first = await request()
    const second = await request()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toMatchObject({ configPrEnqueued: true })
    expect(await second.json()).toMatchObject({ configPrEnqueued: false })
    expect(claimNotionConfigPrCreationMock).toHaveBeenCalledTimes(2)
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
  })

  it("does not claim or enqueue a workflow for an unchanged save", async () => {
    patchNotionConnectorConfigMock.mockResolvedValueOnce({
      resources: [resource],
      resourcesChanged: false,
      syncTargetChanged: false,
    })
    const app = createApp()
    const response = await app.request(
      "/demo/api/v1/connectors/notion/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resources: [
            {
              externalId: "page_1",
              type: "page",
              title: "API",
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configPrEnqueued: false })
    expect(claimNotionConfigPrCreationMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("enqueues a changed sync target when resources are already selected", async () => {
    patchNotionConnectorConfigMock.mockResolvedValueOnce({
      resources: [resource],
      resourcesChanged: false,
      syncTargetChanged: true,
    })
    const app = createApp()
    const response = await app.request(
      "/demo/api/v1/connectors/notion/config?connectionId=con_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          syncTarget: {
            repositoryId: "repo_2",
            branch: "main",
            enabled: true,
          },
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configPrEnqueued: true })
    expect(claimNotionConfigPrCreationMock).toHaveBeenCalledTimes(1)
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
  })
})
