import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getDashboardSummaryMock = vi.hoisted(() => vi.fn())
const getDashboardActivityMock = vi.hoisted(() => vi.fn())
const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())

vi.mock("../../domain/dashboard.js", () => ({
  getDashboardSummary: getDashboardSummaryMock,
  getDashboardActivity: getDashboardActivityMock,
}))

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: {
      getActiveMemberRole: getActiveMemberRoleMock,
    },
  }),
}))

import { dashboardRoutes } from "./dashboard.js"

function appForDashboard() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/:orgSlug/dashboard", dashboardRoutes)
  return app
}

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "member" })
    getDashboardSummaryMock.mockResolvedValue({
      health: {
        overall: "ok",
        repositories: {
          status: "ok",
          total: 1,
          indexed: 1,
          indexing: 0,
          notReady: 0,
        },
        graph: {
          status: "ok",
          totalNodes: 2,
          totalEdges: 1,
          lastObservedAt: null,
        },
        connectors: {
          status: "ok",
          github: { total: 1, installed: 1, needsSetup: 0 },
          forge: { total: 0, installed: 0, running: 0, failed: 0 },
        },
        confluence: {
          status: "ok",
          syncTargets: 0,
          enabledTargets: 0,
          spaces: 0,
          lastSyncedAt: null,
        },
        evidence: {
          status: "ok",
          activeClaims: 1,
          lowConfidenceClaims: 0,
          instructionUnits: 0,
          lastObservedAt: null,
        },
      },
      actions: [],
      activity: { range: "7d", buckets: [], members: null },
    })
    getDashboardActivityMock.mockResolvedValue({
      range: "30d",
      buckets: [],
      members: null,
    })
  })

  it("returns summary with member activity hidden for regular members", async () => {
    const res = await appForDashboard().request(
      "/acme/dashboard/summary?range=7d",
    )

    expect(res.status).toBe(200)
    expect(getDashboardSummaryMock).toHaveBeenCalledWith({
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
      range: "7d",
      includeMembers: false,
    })
  })

  it("includes member activity for org admins", async () => {
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })

    const res = await appForDashboard().request("/acme/dashboard/activity")

    expect(res.status).toBe(200)
    expect(getDashboardActivityMock).toHaveBeenCalledWith({
      orgId: "org_1",
      userId: "user_1",
      range: "30d",
      includeMembers: true,
    })
  })
})
