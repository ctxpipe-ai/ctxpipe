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
const upsertPendingForgeInstallationMock = vi.hoisted(() => vi.fn())

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
    upsertPendingForgeInstallation: upsertPendingForgeInstallationMock,
  }
})

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
    upsertPendingForgeInstallationMock.mockResolvedValue({
      id: "fgi_default",
      orgId: "org_1",
      cloudId: null,
      status: "pending",
      installedByUserId: "user_1",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    })
  })

  it("GET /status returns connector state", async () => {
    getAtlassianUserAccessTokenMock.mockResolvedValueOnce("atl_token")
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
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
})
