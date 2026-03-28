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
const listConfluenceSelectionsByOrgIdMock = vi.hoisted(() => vi.fn())
const getAtlassianUserAccessTokenMock = vi.hoisted(() => vi.fn())
const replaceConfluenceSelectionsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/atlassian-connector.js", () => ({
  getForgeInstallationByOrgId: getForgeInstallationByOrgIdMock,
  listConfluenceSelectionsByOrgId: listConfluenceSelectionsByOrgIdMock,
  getAtlassianUserAccessToken: getAtlassianUserAccessTokenMock,
  replaceConfluenceSelections: replaceConfluenceSelectionsMock,
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
    listConfluenceSelectionsByOrgIdMock.mockResolvedValue([])
    getAtlassianUserAccessTokenMock.mockResolvedValue(undefined)
    replaceConfluenceSelectionsMock.mockResolvedValue([])
  })

  it("GET /status returns connector state", async () => {
    getAtlassianUserAccessTokenMock.mockResolvedValueOnce("atl_token")
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      status: "installed",
      cloudId: "cloud_1",
    })
    listConfluenceSelectionsByOrgIdMock.mockResolvedValueOnce([{ id: "row_1" }])

    const app = createApp()
    const res = await app.request("/connectors/atlassian/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      isLinked: true,
      isInstalled: true,
        installationStatus: "installed",
      selectedPageCount: 1,
    })
  })

  it("PUT /selection saves selections", async () => {
    getForgeInstallationByOrgIdMock.mockResolvedValueOnce({
      status: "installed",
      cloudId: "cloud_1",
    })
    replaceConfluenceSelectionsMock.mockResolvedValueOnce([
      { id: "csp_1" },
      { id: "csp_2" },
    ])

    const app = createApp()
    const res = await app.request("/connectors/atlassian/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selections: [
          {
            spaceId: "space-1",
            pageId: "page-1",
          },
          {
            spaceId: "space-1",
            pageId: "page-2",
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ savedCount: 2 })
  })
})
