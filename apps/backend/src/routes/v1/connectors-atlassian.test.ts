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
const listConfluenceSpacesByConnectionIdMock = vi.hoisted(() => vi.fn())
const upsertPendingForgeInstallationMock = vi.hoisted(() => vi.fn())
const patchAtlassianConnectorConfigMock = vi.hoisted(() => vi.fn())
const deleteForgeInstallationByOrgIdMock = vi.hoisted(() => vi.fn())
const orgHasAnyGithubConnectionMock = vi.hoisted(() => vi.fn())
const getConfluenceSyncTargetWithRepoByOrgIdMock = vi.hoisted(() => vi.fn())
const getConfluenceSyncTargetWithRepoByConnectionIdMock = vi.hoisted(() =>
  vi.fn(),
)
const markAwaitingConfigMergeSetupMock = vi.hoisted(() => vi.fn())
const markConfluenceSyncTargetInitialSyncMock = vi.hoisted(() => vi.fn())
const loadConfluenceScopeFromRepoMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())
const enqueueConnectorConfigSyncMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/atlassian-connector.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/atlassian-connector.js")>()
  return {
    ...actual,
    getForgeInstallationByOrgId: getForgeInstallationByOrgIdMock,
    resolveForgeInstallationForOrg: async (
      orgId: string,
      connectionId?: string | null,
    ) => {
      if (connectionId) {
        const row = await getForgeInstallationByOrgIdMock(orgId)
        if (row && row.id === connectionId) return row
        return undefined
      }
      return getForgeInstallationByOrgIdMock(orgId)
    },
    getAtlassianUserAccessToken: getAtlassianUserAccessTokenMock,
    getPendingForgeInstallationForUserInOtherOrg:
      getPendingForgeInstallationForUserInOtherOrgMock,
    listConfluenceSpacesByConnectionId: listConfluenceSpacesByConnectionIdMock,
    patchAtlassianConnectorConfig: patchAtlassianConnectorConfigMock,
    deleteForgeInstallationByOrgId: deleteForgeInstallationByOrgIdMock,
    upsertPendingForgeInstallation: upsertPendingForgeInstallationMock,
  }
})

vi.mock("../../models/github-installation.js", () => ({
  orgHasAnyGithubConnection: orgHasAnyGithubConnectionMock,
}))

vi.mock("../../models/confluence-sync-target.js", () => ({
  getConfluenceSyncTargetWithRepoByOrgId:
    getConfluenceSyncTargetWithRepoByOrgIdMock,
  getConfluenceSyncTargetWithRepoByConnectionId:
    getConfluenceSyncTargetWithRepoByConnectionIdMock,
  markAwaitingConfigMergeSetup: markAwaitingConfigMergeSetupMock,
  markConfluenceSyncTargetInitialSync: markConfluenceSyncTargetInitialSyncMock,
}))

vi.mock("../../services/confluence/config-from-repo.js", () => ({
  loadConfluenceScopeFromRepo: loadConfluenceScopeFromRepoMock,
}))

vi.mock("../../openworkflow/workflows/confluence-sync-content.js", () => ({
  confluenceSyncContent: { spec: { name: "confluence-sync-content" } },
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
  runWorkflowWithWorkerWake: (...args: unknown[]) => runWorkflowMock(...args),
}))

vi.mock("../../openworkflow/enqueue-connector-config-sync.js", () => ({
  enqueueConnectorConfigSync: enqueueConnectorConfigSyncMock,
}))

import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { atlassianConnectorRoutes } from "./connectors-atlassian.js"

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    c.set("orgSlug", "acme")
    c.set("env", {} as AppEnv["Variables"]["env"])
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
    listConfluenceSpacesByConnectionIdMock.mockResolvedValue([])
    orgHasAnyGithubConnectionMock.mockResolvedValue(false)
    getConfluenceSyncTargetWithRepoByOrgIdMock.mockResolvedValue(undefined)
    getConfluenceSyncTargetWithRepoByConnectionIdMock.mockImplementation(
      async (orgId: string) =>
        getConfluenceSyncTargetWithRepoByOrgIdMock(orgId),
    )
    runWorkflowMock.mockResolvedValue({ status: "completed" })
    enqueueConnectorConfigSyncMock.mockResolvedValue({
      accepted: true,
      started: true,
    })
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
    deleteForgeInstallationByOrgIdMock.mockResolvedValue(true)
    markAwaitingConfigMergeSetupMock.mockResolvedValue(undefined)
    markConfluenceSyncTargetInitialSyncMock.mockResolvedValue(undefined)
    loadConfluenceScopeFromRepoMock.mockResolvedValue(undefined)
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
      setupPhase: "draft",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      syncTarget: null,
      selectedSpaces: [],
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

    it("registers pending install when Atlassian account is not yet linked", async () => {
      getAtlassianUserAccessTokenMock.mockResolvedValueOnce(undefined)
      const app = createApp()
      const res = await app.request("/connectors/atlassian/installation", {
        method: "POST",
      })

      expect(res.status).toBe(200)
      expect(upsertPendingForgeInstallationMock).toHaveBeenCalledWith({
        orgId: "org_1",
        installedByUserId: "user_1",
        installOpened: false,
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
        installOpened: false,
      })
    })
  })

  it("DELETE /connectors/atlassian removes installation for org", async () => {
    const app = createApp()
    const res = await app.request("/connectors/atlassian", { method: "DELETE" })
    expect(res.status).toBe(204)
    expect(deleteForgeInstallationByOrgIdMock).toHaveBeenCalledWith("org_1")
    expect(await res.text()).toBe("")
  })
})
