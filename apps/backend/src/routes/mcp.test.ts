import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { MCP_SSE_OPEN_COMMENT } from "../mcp/transport.js"
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

const MCP_ACCEPT = "application/json, text/event-stream"

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel()
}

async function readSseOpenSignal(response: Response): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>
  firstChunk: string
}> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Expected an SSE response body")
  }
  const first = await reader.read()
  return {
    reader,
    firstChunk: new TextDecoder().decode(first.value),
  }
}

async function readSseJsonResult(response: Response): Promise<unknown> {
  const text = await response.text()
  const dataLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"))
  if (!dataLine) {
    throw new Error(`Expected SSE data in:\n${text}`)
  }
  return JSON.parse(dataLine.slice("data:".length).trim()) as unknown
}

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
    registerMcpToolsMock.mockImplementation((server) => {
      server.registerTool(
        "handshake_ping",
        {
          title: "Handshake ping",
          description: "Deterministic tool for MCP handshake tests.",
        },
        async () => ({
          content: [{ type: "text", text: "pong" }],
        }),
      )
    })
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
    await cancelBody(response)
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

  it("rejects unauthenticated GET before opening an SSE listener", async () => {
    requireAuthMock.mockImplementationOnce(async (c) =>
      c.json({ error: "Unauthorized" }, 401),
    )

    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "GET",
      headers: { accept: "text/event-stream" },
    })

    expect(response.status).toBe(401)
    expect(registerMcpToolsMock).not.toHaveBeenCalled()
  })

  it("completes the CodeRabbit Streamable HTTP handshake over a GET listener", async () => {
    const app = createTestApp()

    const initialize = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: MCP_ACCEPT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "coderabbit", version: "1.0.0" },
        },
      }),
    })
    expect(initialize.status).toBe(200)
    const initializeResult = await readSseJsonResult(initialize)
    expect(initializeResult).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-11-25" },
    })

    const initialized = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: MCP_ACCEPT,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    })
    expect(initialized.status).toBe(202)
    expect(await initialized.text()).toBe("")

    const listener = await app.request("/mcp?orgSlug=acme", {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
    })
    expect(listener.status).toBe(200)
    expect(listener.headers.get("content-type")).toContain("text/event-stream")
    expect(registerMcpToolsMock).toHaveBeenCalled()
    const { reader, firstChunk } = await readSseOpenSignal(listener)
    expect(firstChunk).toBe(MCP_SSE_OPEN_COMMENT)

    const toolsList = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: MCP_ACCEPT,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    })
    expect(toolsList.status).toBe(200)
    const toolsResult = await readSseJsonResult(toolsList)
    expect(toolsResult).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: expect.any(Array) },
    })

    const toolCall = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: MCP_ACCEPT,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "handshake_ping", arguments: {} },
      }),
    })
    expect(toolCall.status).toBe(200)
    expect(await readSseJsonResult(toolCall)).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: "pong" }],
      },
    })

    await reader.cancel()
    expect(loggerInfoMock).toHaveBeenCalledWith("MCP stream opened")
    expect(loggerInfoMock).toHaveBeenCalledWith("MCP stream closed")
    expect(loggerSetMock.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            step: "mcp.request",
            mcp: expect.objectContaining({
              method: "GET",
              stream: "closed",
              closeReason: "cancelled",
            }),
          }),
        ],
      ]),
    )
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
    await cancelBody(response)
  })

  it("logs bounded MCP metadata without request payloads or JSON-RPC ids", async () => {
    const app = createTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: {
        accept: MCP_ACCEPT,
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
    await cancelBody(response)
    expect(loggerSetMock).toHaveBeenCalledWith({
      step: "mcp.request",
      mcp: {
        rpcMethods: ["initialize"],
        protocolVersion: "2025-11-25",
        authType: "cookie",
        orgSlug: null,
        method: "POST",
        clientName: "secret-client",
        clientVersion: "1.0.0",
        status: 200,
        durationMs: expect.any(Number),
        stream: "opened",
      },
    })
    expect(loggerInfoMock).toHaveBeenCalledWith("MCP stream opened")
    expect(loggerInfoMock).toHaveBeenCalledWith("MCP stream closed")
    expect(JSON.stringify(loggerSetMock.mock.calls)).not.toContain(
      "sensitive-request-id",
    )
    expect(JSON.stringify(loggerSetMock.mock.calls)).not.toContain(
      "initialize-params-secret",
    )
  })
})
