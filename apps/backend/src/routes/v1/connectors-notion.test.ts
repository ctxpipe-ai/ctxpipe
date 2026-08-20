import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const claimNotionConfigPrCreationMock = vi.hoisted(() => vi.fn())
const claimNotionContentSyncRetryMock = vi.hoisted(() => vi.fn())
const patchNotionConnectorConfigMock = vi.hoisted(() => vi.fn())
const releaseNotionConfigPrCreationClaimMock = vi.hoisted(() => vi.fn())
const resolveNotionConnectionForOrgDetailedMock = vi.hoisted(() => vi.fn())
const getNotionBindingWithRepoByConnectionIdMock = vi.hoisted(() => vi.fn())
const loadNotionScopeFromRepoMock = vi.hoisted(() => vi.fn())
const getPullRequestHeadBranchMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())
const transitionNotionBindingStateMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/notion-connector.js", () => ({
  claimNotionContentSyncRetry: claimNotionContentSyncRetryMock,
  claimNotionConfigPrCreation: claimNotionConfigPrCreationMock,
  deleteNotionConnectionById: vi.fn(),
  getNotionBindingWithRepoByConnectionId:
    getNotionBindingWithRepoByConnectionIdMock,
  MULTIPLE_NOTION_CONNECTIONS_MESSAGE:
    "Multiple Notion connections for this organization; specify connectionId query parameter",
  patchNotionConnectorConfig: patchNotionConnectorConfigMock,
  releaseNotionConfigPrCreationClaim: releaseNotionConfigPrCreationClaimMock,
  resolveNotionConnectionForOrgDetailed:
    resolveNotionConnectionForOrgDetailedMock,
  transitionNotionBindingState: transitionNotionBindingStateMock,
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
vi.mock("../../openworkflow/workflows/notion-sync-content.js", () => ({
  notionSyncContent: { spec: { name: "notion-sync-content" } },
}))

vi.mock("../../services/notion/client.js", () => ({
  exchangeNotionOAuthCode: vi.fn(),
  getNotionOAuthAuthorizeUrl: vi.fn(),
  searchNotionResources: vi.fn(),
}))

vi.mock("../../services/notion/config-from-repo.js", () => ({
  loadNotionScopeFromRepo: loadNotionScopeFromRepoMock,
  NOTION_CONFIG_PATH: "notion/config.yaml",
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  getPullRequestHeadBranch: getPullRequestHeadBranchMock,
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
    c.set("env", {} as AppEnv["Variables"]["env"])
    await next()
  })
  app.onError((error, c) => c.json({ error: error.message }, 500))
  app.route("/:orgSlug/api/v1/connectors/notion", notionConnectorRoutes)
  return app
}

const binding = {
  id: "con_1",
  orgId: "org_1",
  connectionId: "con_1",
  repositoryId: "repo_1",
  repositoryName: "acme/docs",
  githubConnectionId: "ghc_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  createdAt: new Date("2026-07-31T00:00:00.000Z"),
  updatedAt: new Date("2026-07-31T00:00:00.000Z"),
}

const pageResource = {
  externalId: "page_1",
  type: "page" as const,
  title: "API",
}

function patchResources() {
  return app().request(
    "/demo/api/v1/connectors/notion/config?connectionId=con_1",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resources: [pageResource] }),
    },
  )
}

let app: () => OpenAPIHono<AppEnv>

describe("Notion connector config", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp
    resolveNotionConnectionForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      connection: {
        id: "con_1",
        orgId: "org_1",
        status: "installed",
        accessToken: "notion_token",
      },
    })
    getNotionBindingWithRepoByConnectionIdMock.mockResolvedValue(binding)
    // Git scope starts empty, so a page selection is a change by default.
    loadNotionScopeFromRepoMock.mockResolvedValue({ resources: [] })
    patchNotionConnectorConfigMock.mockResolvedValue({
      bindingChanged: false,
    })
    claimNotionConfigPrCreationMock.mockResolvedValue({
      pendingConfigPullUrl: null,
      setupPhase: "live",
    })
    claimNotionContentSyncRetryMock.mockResolvedValue(true)
    transitionNotionBindingStateMock.mockResolvedValue(true)
    runWorkflowMock.mockResolvedValue({ status: "running" })
    releaseNotionConfigPrCreationClaimMock.mockResolvedValue(undefined)
  })

  it("returns live status without reading GitHub scope config", async () => {
    const response = await app().request(
      "/demo/api/v1/connectors/notion/status?connectionId=con_1",
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      selectedResourceCount: null,
      setupPhase: "live",
    })
    expect(loadNotionScopeFromRepoMock).not.toHaveBeenCalled()
  })

  it("enqueues the config workflow with the requested resources when the git scope differs", async () => {
    const response = await patchResources()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configPrEnqueued: true })
    expect(claimNotionConfigPrCreationMock).toHaveBeenCalledTimes(1)
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-config" },
      {
        orgId: "org_1",
        orgSlug: "demo",
        connectionId: "con_1",
        resources: [pageResource],
      },
    )
  })

  it("enqueues only once when overlapping saves both report a change", async () => {
    claimNotionConfigPrCreationMock
      .mockResolvedValueOnce({
        pendingConfigPullUrl: null,
        setupPhase: "live",
      })
      .mockResolvedValueOnce(undefined)

    const first = await patchResources()
    const second = await patchResources()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toMatchObject({ configPrEnqueued: true })
    expect(await second.json()).toMatchObject({ configPrEnqueued: false })
    expect(claimNotionConfigPrCreationMock).toHaveBeenCalledTimes(2)
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
  })

  it("does not claim or enqueue a workflow when the selection matches the git scope", async () => {
    loadNotionScopeFromRepoMock.mockResolvedValue({ resources: [pageResource] })

    const response = await patchResources()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configPrEnqueued: false })
    expect(claimNotionConfigPrCreationMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("does not enqueue a config PR for a binding-only change (scope stays git-native)", async () => {
    patchNotionConnectorConfigMock.mockResolvedValueOnce({
      bindingChanged: true,
    })

    const response = await app().request(
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
    expect(await response.json()).toMatchObject({ configPrEnqueued: false })
    expect(claimNotionConfigPrCreationMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("releases the PR claim when workflow enqueue fails", async () => {
    runWorkflowMock.mockRejectedValueOnce(new Error("worker unavailable"))

    const response = await patchResources()

    expect(response.status).toBe(503)
    expect(releaseNotionConfigPrCreationClaimMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      previousState: {
        pendingConfigPullUrl: null,
        setupPhase: "live",
      },
    })
  })

  it("retries failed configuration from the pull request branch", async () => {
    getNotionBindingWithRepoByConnectionIdMock.mockResolvedValueOnce({
      ...binding,
      setupPhase: "config_failed",
      pendingConfigPullUrl: "https://github.com/acme/docs/pull/42",
    })
    getPullRequestHeadBranchMock.mockResolvedValueOnce(
      "ctxpipe/notion-config-con_1",
    )
    loadNotionScopeFromRepoMock.mockResolvedValueOnce({
      resources: [pageResource],
    })
    claimNotionConfigPrCreationMock.mockResolvedValueOnce({
      pendingConfigPullUrl: "https://github.com/acme/docs/pull/42",
      setupPhase: "config_failed",
    })

    const response = await app().request(
      "/demo/api/v1/connectors/notion/retry-config?connectionId=con_1",
      { method: "POST" },
    )

    expect(response.status).toBe(202)
    expect(getPullRequestHeadBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullUrl: "https://github.com/acme/docs/pull/42",
      }),
    )
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-config" },
      {
        orgId: "org_1",
        orgSlug: "demo",
        connectionId: "con_1",
        resources: [pageResource],
      },
    )
  })

  it("retries failed configuration with submitted resources", async () => {
    getNotionBindingWithRepoByConnectionIdMock.mockResolvedValueOnce({
      ...binding,
      setupPhase: "config_failed",
      pendingConfigPullUrl: null,
    })
    loadNotionScopeFromRepoMock.mockResolvedValueOnce(undefined)

    const response = await app().request(
      "/demo/api/v1/connectors/notion/retry-config?connectionId=con_1",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resources: [pageResource] }),
      },
    )

    expect(response.status).toBe(202)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-config" },
      expect.objectContaining({ resources: [pageResource] }),
    )
  })

  it("retries a failed content sync", async () => {
    getNotionBindingWithRepoByConnectionIdMock.mockResolvedValueOnce({
      ...binding,
      setupPhase: "sync_failed",
    })

    const response = await app().request(
      "/demo/api/v1/connectors/notion/retry?connectionId=con_1",
      { method: "POST" },
    )

    expect(response.status).toBe(202)
    expect(claimNotionContentSyncRetryMock).toHaveBeenCalledWith("con_1")
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-content" },
      {
        orgId: "org_1",
        orgSlug: "demo",
        connectionId: "con_1",
      },
    )
  })

  it("does not retry content outside sync_failed", async () => {
    const response = await app().request(
      "/demo/api/v1/connectors/notion/retry?connectionId=con_1",
      { method: "POST" },
    )

    expect(response.status).toBe(400)
    expect(claimNotionContentSyncRetryMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("restores sync_failed when content retry enqueue fails", async () => {
    getNotionBindingWithRepoByConnectionIdMock.mockResolvedValueOnce({
      ...binding,
      setupPhase: "sync_failed",
    })
    runWorkflowMock.mockRejectedValueOnce(new Error("worker unavailable"))

    const response = await app().request(
      "/demo/api/v1/connectors/notion/retry?connectionId=con_1",
      { method: "POST" },
    )

    expect(response.status).toBe(500)
    expect(transitionNotionBindingStateMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      expectedSetupPhase: "initial_sync",
      expectedPendingConfigPrCreating: false,
      repositoryId: "repo_1",
      branch: "main",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "sync_failed",
    })
  })
})
