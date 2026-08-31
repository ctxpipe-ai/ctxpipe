import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { registerMcpRoutes } from "./mcp.js"

const {
  withCookieAuthMock,
  withBearerAuthMock,
  requireAuthMock,
  withNetworkOrgContextMock,
  registerMcpToolsMock,
  loggerSetMock,
  loggerInfoMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  withCookieAuthMock: vi.fn(),
  withBearerAuthMock: vi.fn(),
  requireAuthMock: vi.fn(),
  withNetworkOrgContextMock: vi.fn(),
  registerMcpToolsMock: vi.fn(),
  loggerSetMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}))

vi.mock("../auth/withAuth.js", () => ({
  withCookieAuth: withCookieAuthMock,
  withBearerAuth: withBearerAuthMock,
  requireAuth: requireAuthMock,
  withNetworkOrgContext: withNetworkOrgContextMock,
}))

vi.mock("../mcp/tools.js", () => ({
  registerMcpTools: registerMcpToolsMock,
}))

vi.mock("../observability/logger.js", () => ({
  getLogger: () => ({
    set: loggerSetMock,
    info: loggerInfoMock,
    error: loggerErrorMock,
  }),
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
    c.set("oauthOrganizationId", null)
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
    withCookieAuthMock.mockImplementation(async (_c, next) => next())
    withBearerAuthMock.mockImplementation(async (_c, next) => next())
    requireAuthMock.mockImplementation(async (_c, next) => next())
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

  it("reaches MCP handler when orgSlug is omitted", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "route-test", version: "1.0.0" },
        },
      }),
    })

    expect(registerMcpToolsMock).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
  })

  it("rejects an untrusted browser origin before authentication", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })

    expect(response.status).toBe(403)
    expect(withCookieAuthMock).not.toHaveBeenCalled()
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("returns 405 instead of opening an SSE stream for stateless GET", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme")

    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST, DELETE")
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("returns an empty 202 response for notification-only POSTs", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")
    expect(response.headers.get("content-type")).toBeNull()
  })

  it("reaches MCP handler for authenticated requests with valid orgSlug", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", { method: "POST" })

    expect(registerMcpToolsMock).toHaveBeenCalledTimes(1)
    expect([200, 204, 400, 406]).toContain(response.status)
  })

  it("logs bounded MCP metadata without request payloads or JSON-RPC ids", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sensitive-request-id",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "secret-client", version: "1.0.0" },
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(loggerSetMock).toHaveBeenCalledWith({
      step: "mcp.request",
      mcp: {
        rpcMethods: ["initialize"],
        protocolVersion: "2025-11-25",
        authType: "cookie",
        orgSlug: null,
        status: 200,
        durationMs: expect.any(Number),
      },
    })
    expect(loggerInfoMock).toHaveBeenCalledWith("MCP request completed")
    expect(JSON.stringify(loggerSetMock.mock.calls)).not.toContain(
      "sensitive-request-id",
    )
    expect(JSON.stringify(loggerSetMock.mock.calls)).not.toContain(
      "secret-client",
    )
  })
})
