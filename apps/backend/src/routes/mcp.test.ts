import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { registerMcpRoutes } from "./mcp.js"

const {
  withApiKeyAuthMock,
  withCookieAuthMock,
  withBearerAuthMock,
  requireAuthMock,
  requireMcpApiKeyScopeMock,
  withNetworkOrgContextMock,
  registerMcpToolsMock,
} = vi.hoisted(() => ({
  withApiKeyAuthMock: vi.fn(),
  withCookieAuthMock: vi.fn(),
  withBearerAuthMock: vi.fn(),
  requireAuthMock: vi.fn(),
  requireMcpApiKeyScopeMock: vi.fn(),
  withNetworkOrgContextMock: vi.fn(),
  registerMcpToolsMock: vi.fn(),
}))

vi.mock("../auth/withAuth.js", () => ({
  withApiKeyAuth: withApiKeyAuthMock,
  withCookieAuth: withCookieAuthMock,
  withBearerAuth: withBearerAuthMock,
  requireAuth: requireAuthMock,
  withNetworkOrgContext: withNetworkOrgContextMock,
}))

vi.mock("../auth/apiKeyScopes.js", () => ({
  requireMcpApiKeyScope: requireMcpApiKeyScopeMock,
}))

vi.mock("../mcp/tools.js", () => ({
  registerMcpTools: registerMcpToolsMock,
}))

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", {
      DATABASE_URL: "",
      AUTH_BASE_URL: "https://localhost:3000",
    } as AppEnv["Variables"]["env"])
    c.set("user", null)
    c.set("session", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    c.set("apiKeyAuth", null)
    await next()
  })
  registerMcpRoutes(app)
  return app
}

describe("MCP route auth and org validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withApiKeyAuthMock.mockImplementation(async (_c, next) => next())
    withCookieAuthMock.mockImplementation(async (_c, next) => next())
    withBearerAuthMock.mockImplementation(async (_c, next) => next())
    requireAuthMock.mockImplementation(async (_c, next) => next())
    requireMcpApiKeyScopeMock.mockImplementation(async (_c, next) => next())
    withNetworkOrgContextMock.mockImplementation(async (_c, next) => next())
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
    withNetworkOrgContextMock.mockImplementationOnce(async (c) =>
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

  it("returns 400 JSON-RPC error for missing orgSlug query", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp", { method: "POST" })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } })
  })

  it("reaches MCP handler for authenticated requests with valid orgSlug", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", { method: "POST" })

    expect(registerMcpToolsMock).toHaveBeenCalledTimes(1)
    expect([200, 204, 400, 406]).toContain(response.status)
  })
})
