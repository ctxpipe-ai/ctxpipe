import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { registerMcpRoutes } from "./mcp.js"

const {
  withBearerAuthMock,
  requireAuthMock,
  withOrgContextMock,
  registerMcpToolsMock,
} = vi.hoisted(() => ({
  withBearerAuthMock: vi.fn(),
  requireAuthMock: vi.fn(),
  withOrgContextMock: vi.fn(),
  registerMcpToolsMock: vi.fn(),
}))

vi.mock("../auth/withAuth.js", () => ({
  withBearerAuth: withBearerAuthMock,
  requireAuth: requireAuthMock,
  withOrgContext: withOrgContextMock,
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
    withBearerAuthMock.mockImplementation(async (_c, next) => next())
    requireAuthMock.mockImplementation(async (_c, next) => next())
    withOrgContextMock.mockImplementation(async (_c, next) => next())
  })

  it("rejects unauthenticated requests", async () => {
    requireAuthMock.mockImplementationOnce(async (c) =>
      c.json({ error: "Unauthorized" }, 401),
    )

    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", { method: "POST" })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("rejects unknown orgSlug with not found", async () => {
    withOrgContextMock.mockImplementationOnce(async (c) =>
      c.json({ error: "Not found" }, 404),
    )

    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=missing", {
      method: "POST",
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("returns not found for missing orgSlug route usage", async () => {
    withOrgContextMock.mockImplementationOnce(async (c, next) => {
      if (!c.req.query("orgSlug")) {
        return c.json({ error: "Not found" }, 404)
      }
      return next()
    })
    const app = createTestApp()
    const response = await app.request("/mcp", { method: "POST" })
    expect(response.status).toBe(404)
  })

  it("reaches MCP handler for authenticated requests with valid orgSlug", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", { method: "POST" })

    expect(registerMcpToolsMock).toHaveBeenCalledTimes(1)
    expect([200, 204, 400, 406]).toContain(response.status)
  })
})
