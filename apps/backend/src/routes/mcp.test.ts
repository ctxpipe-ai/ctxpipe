import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { registerMcpRoutes } from "./mcp.js"

const { getSessionMock, listOrganizationsMock, registerMcpToolsMock } = vi.hoisted(
  () => ({
    getSessionMock: vi.fn(),
    listOrganizationsMock: vi.fn(),
    registerMcpToolsMock: vi.fn(),
  }),
)

vi.mock("../auth/config.js", () => ({
  getAuth: () => ({
    api: {
      getSession: getSessionMock,
      listOrganizations: listOrganizationsMock,
    },
  }),
}))

vi.mock("../mcp/tools.js", () => ({
  registerMcpTools: registerMcpToolsMock,
}))

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", { DATABASE_URL: "" } as AppEnv["Variables"]["env"])
    c.set("user", null)
    c.set("session", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  registerMcpRoutes(app)
  return app
}

describe("MCP route auth and org validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects unauthenticated requests", async () => {
    getSessionMock.mockResolvedValueOnce(null)

    const app = createTestApp()
    const response = await app.request("/acme/mcp", { method: "POST" })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("rejects unknown orgSlug with not found", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_1" },
      session: { id: "sess_1", userId: "user_1" },
    })
    listOrganizationsMock.mockResolvedValueOnce([{ id: "org_2", slug: "other-org" }])

    const app = createTestApp()
    const response = await app.request("/acme/mcp", { method: "POST" })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("returns not found for missing orgSlug route usage", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp", { method: "POST" })
    expect(response.status).toBe(404)
  })

  it("reaches MCP handler for authenticated requests with valid orgSlug", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_1" },
      session: { id: "sess_1", userId: "user_1" },
    })
    listOrganizationsMock.mockResolvedValueOnce([{ id: "org_1", slug: "acme" }])

    const app = createTestApp()
    const response = await app.request("/acme/mcp", { method: "POST" })

    expect(registerMcpToolsMock).toHaveBeenCalledTimes(1)
    expect([200, 204, 400, 406]).toContain(response.status)
  })
})
