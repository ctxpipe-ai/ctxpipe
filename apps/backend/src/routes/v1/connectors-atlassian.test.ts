import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getActiveMemberRole: getActiveMemberRoleMock },
  }),
}))

const getForgeInstallationByOrgIdMock = vi.hoisted(() => vi.fn())
const getAtlassianUserAccessTokenMock = vi.hoisted(() => vi.fn())
const getPendingForgeInstallationForUserInOtherOrgMock = vi.hoisted(() =>
  vi.fn(),
)
const listConfluenceSpacesByForgeInstallationIdMock = vi.hoisted(() => vi.fn())
const upsertPendingForgeInstallationMock = vi.hoisted(() => vi.fn())
const patchAtlassianConnectorConfigMock = vi.hoisted(() => vi.fn())
const getGithubInstallationByOrgIdMock = vi.hoisted(() => vi.fn())
const getConfluenceSyncTargetByOrgIdMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/atlassian-connector.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../models/atlassian-connector.js")
  >()
  return {
    ...actual,
    getForgeInstallationByOrgId: getForgeInstallationByOrgIdMock,
    getAtlassianUserAccessToken: getAtlassianUserAccessTokenMock,
    getPendingForgeInstallationForUserInOtherOrg:
      getPendingForgeInstallationForUserInOtherOrgMock,
    listConfluenceSpacesByForgeInstallationId:
      listConfluenceSpacesByForgeInstallationIdMock,
    patchAtlassianConnectorConfig: patchAtlassianConnectorConfigMock,
    upsertPendingForgeInstallation: upsertPendingForgeInstallationMock,
  }
})

vi.mock("../../models/github-installation.js", () => ({
  getInstallationByOrgId: getGithubInstallationByOrgIdMock,
}))

vi.mock("../../models/confluence-sync-target.js", () => ({
  getConfluenceSyncTargetByOrgId: getConfluenceSyncTargetByOrgIdMock,
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
}))

import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { atlassianConnectorRoutes } from "./connectors-atlassian.js"

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  const scoped = new OpenAPIHono<AppEnv>()
    .use("*", requireOrgAdminOrOwner)
    .route("/", atlassianConnectorRoutes)
  app.route("/connectors/atlassian", scoped)
  return app
}

describe("Atlassian connector routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    getForgeInstallationByOrgIdMock.mockResolvedValue(undefined)
    getAtlassianUserAccessTokenMock.mockResolvedValue(undefined)
    getPendingForgeInstallationForUserInOtherOrgMock.mockResolvedValue(
      undefined,
    )
    listConfluenceSpacesByForgeInstallationIdMock.mockResolvedValue([])
    getGithubInstallationByOrgIdMock.mockResolvedValue(undefined)
    getConfluenceSyncTargetByOrgIdMock.mockResolvedValue(undefined)
    runWorkflowMock.mockResolvedValue({ status: "completed" })
    upsertPendingForgeInstallationMock.mockResolvedValue({
      id: "fgi_default",
      orgId: "org_1",
      cloudId: null,
      status: "pending",
      installedByUserId: "user_1",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
    patchAtlassianConnectorConfigMock.mockResolvedValue({
      spaces: [],
    })
  })

  it("GET /status returns connector state", async () => {
    getAtlassianUserAccessTokenMock.mockResolvedValueOnce("atl_token")
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      id: "fgi_1",
      status: "installed",
      cloudId: "cloud_1",
    })

    const app = createApp()
    const res = await app.request("/connectors/atlassian/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      isLinked: true,
      isInstalled: true,
      installationStatus: "installed",
      isGithubLinked: false,
      selectedSpaceCount: 0,
      syncTargetConfigured: false,
    })
  })

  describe("POST /connectors/atlassian/installation", () => {
    beforeEach(() => {
      getAtlassianUserAccessTokenMock.mockResolvedValue("atl_token")
      getPendingForgeInstallationForUserInOtherOrgMock.mockResolvedValue(
        undefined,
      )
      upsertPendingForgeInstallationMock.mockResolvedValue({
        id: "fgi_1",
        orgId: "org_1",
        cloudId: null,
        status: "pending",
        installedByUserId: "user_1",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      })
    })

    it("returns 409 when Atlassian account is not linked", async () => {
      getAtlassianUserAccessTokenMock.mockResolvedValueOnce(undefined)
      const app = createApp()
      const res = await app.request("/connectors/atlassian/installation", {
        method: "POST",
      })

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: "Atlassian account not linked",
        code: "atlassian_not_linked",
      })
    })

    it("returns 409 when user already has pending install in another org", async () => {
      getPendingForgeInstallationForUserInOtherOrgMock.mockResolvedValueOnce({
        id: "fgi_pending_other",
        orgId: "org_2",
      })

      const app = createApp()
      const res = await app.request("/connectors/atlassian/installation", {
        method: "POST",
      })

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        code: "atlassian_pending_installation_exists",
      })
      expect(upsertPendingForgeInstallationMock).not.toHaveBeenCalled()
    })

    it("creates or updates pending install intent", async () => {
      const app = createApp()
      const res = await app.request("/connectors/atlassian/installation", {
        method: "POST",
      })

      expect(res.status).toBe(200)
      expect(upsertPendingForgeInstallationMock).toHaveBeenCalledWith({
        orgId: "org_1",
        installedByUserId: "user_1",
      })
    })
  })

  it("GET /config returns spaces and sync target", async () => {
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      id: "fgi_1",
      status: "installed",
      cloudId: "cloud_1",
    })
    listConfluenceSpacesByForgeInstallationIdMock.mockResolvedValueOnce([
      {
        id: "csp_1",
        forgeInstallationId: "fgi_1",
        spaceKey: "ENG",
        spaceName: "Engineering",
        selectedPageIds: null,
        lastSyncedPageId: null,
        lastSyncedAt: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ])
    getConfluenceSyncTargetByOrgIdMock.mockResolvedValueOnce({
      id: "cst_1",
      orgId: "org_1",
      forgeInstallationId: "fgi_1",
      repositoryName: "owner/repo",
      branch: "main",
      enabled: true,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })

    const app = createApp()
    const res = await app.request("/connectors/atlassian/config")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      spaces: Array<{ spaceKey: string }>
      syncTarget: { repositoryName: string } | null
    }
    expect(body.spaces[0]?.spaceKey).toBe("ENG")
    expect(body.syncTarget?.repositoryName).toBe("owner/repo")
  })

  it("PATCH /config with spaces enqueues sync workflow", async () => {
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      id: "fgi_1",
      status: "installed",
      cloudId: "cloud_1",
    })
    patchAtlassianConnectorConfigMock.mockResolvedValueOnce({
      spaces: [
        {
          id: "csp_1",
          forgeInstallationId: "fgi_1",
          spaceKey: "ENG",
          spaceName: "Engineering",
          selectedPageIds: null,
          lastSyncedPageId: null,
          lastSyncedAt: null,
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          updatedAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ],
    })

    const app = createApp()
    const res = await app.request("/connectors/atlassian/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaces: [{ spaceKey: "ENG", spaceName: "Engineering", selectedPageIds: null }],
      }),
    })

    expect(res.status).toBe(200)
    expect(patchAtlassianConnectorConfigMock).toHaveBeenCalledWith({
      orgId: "org_1",
      forgeInstallationId: "fgi_1",
      spaces: [
        {
          spaceKey: "ENG",
          spaceName: "Engineering",
          selectedPageIds: null,
        },
      ],
    })
    expect(runWorkflowMock).toHaveBeenCalled()
    const body = (await res.json()) as {
      syncEnqueued: boolean
      workflowName?: string
    }
    expect(body.syncEnqueued).toBe(true)
    expect(body.workflowName).toBeDefined()
  })

  it("PATCH /config with only sync target does not touch scope and does not enqueue sync", async () => {
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      id: "fgi_1",
      status: "installed",
      cloudId: "cloud_1",
    })
    patchAtlassianConnectorConfigMock.mockResolvedValueOnce({
      spaces: [
        {
          id: "csp_1",
          forgeInstallationId: "fgi_1",
          spaceKey: "ENG",
          spaceName: "Engineering",
          selectedPageIds: null,
          lastSyncedPageId: null,
          lastSyncedAt: null,
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          updatedAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ],
    })

    const app = createApp()
    const res = await app.request("/connectors/atlassian/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        syncTarget: {
          repositoryName: "other/repo",
          branch: "develop",
          enabled: false,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(listConfluenceSpacesByForgeInstallationIdMock).not.toHaveBeenCalled()
    expect(patchAtlassianConnectorConfigMock).toHaveBeenCalledWith({
      orgId: "org_1",
      forgeInstallationId: "fgi_1",
      syncTarget: {
        repositoryName: "other/repo",
        branch: "develop",
        enabled: false,
      },
    })
    expect(runWorkflowMock).not.toHaveBeenCalled()
    const body = (await res.json()) as {
      syncEnqueued: boolean
      workflowName?: string
    }
    expect(body.syncEnqueued).toBe(false)
    expect(body.workflowName).toBeUndefined()
  })

  it("PATCH /config with empty body returns 400", async () => {
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      id: "fgi_1",
      status: "installed",
      cloudId: "cloud_1",
    })

    const app = createApp()
    const res = await app.request("/connectors/atlassian/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect(patchAtlassianConnectorConfigMock).not.toHaveBeenCalled()
  })
})
