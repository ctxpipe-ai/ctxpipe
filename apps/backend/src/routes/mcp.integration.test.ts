import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { registerMcpRoutes } from "./mcp.js"

// The real /mcp route: origin check, the auth chain, the default org, and
// the transport, with a real database and the tools that ship.
describe("/mcp route (Postgres)", () => {
  let seed: SeededOrg
  const events: Record<string, unknown>[] = []

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    seed = await seedOrg()
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  function createApp() {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(
      evlog({
        drain: async (ctx) => {
          for (const item of Array.isArray(ctx) ? ctx : [ctx]) {
            events.push(item.event as Record<string, unknown>)
          }
        },
      }),
    )
    app.use("*", async (c, next) => {
      c.set("env", parseEnv(process.env as Record<string, string | undefined>))
      c.set("user", null)
      c.set("session", null)
      c.set("oauthReferenceId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerMcpRoutes(app)
    return app
  }

  const jsonHeaders = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  }

  it("refuses a request with no credential with 401", async () => {
    const response = await createApp().request(`/mcp?orgSlug=${seed.orgSlug}`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(401)
  })

  it("refuses an untrusted browser origin before authentication, also with a valid key", async () => {
    const response = await createApp().request("/mcp", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        origin: "https://evil.example",
        "x-api-key": seed.orgApiKey,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(403)
  })

  it("returns 405 instead of opening an SSE stream for a stateless GET", async () => {
    const response = await createApp().request("/mcp", {
      headers: { "x-api-key": seed.orgApiKey },
    })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST, DELETE")
  })

  it("returns an empty 202 response for a notification-only POST", async () => {
    const response = await createApp().request("/mcp", {
      method: "POST",
      headers: { ...jsonHeaders, "x-api-key": seed.orgApiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")
    expect(response.headers.get("content-type")).toBeNull()
  })

  it("logs bounded MCP metadata without request payloads or JSON-RPC ids", async () => {
    events.length = 0
    const response = await createApp().request("/mcp", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        "mcp-protocol-version": "2025-11-25",
        "x-api-key": seed.orgApiKey,
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
    await new Promise((resolve) => setTimeout(resolve, 50))
    const logged = events.find(
      (event) => (event as { step?: string }).step === "mcp.request",
    )
    // The URL no longer names the org (ADR-051 section 3), so no slug is logged.
    // The key's org is in the request context as `ctxpipe.org.id`.
    expect(logged).toMatchObject({
      "ctxpipe.org.id": seed.orgId,
      mcp: {
        rpcMethods: ["initialize"],
        protocolVersion: "2025-11-25",
        authType: "api-key",
        orgSlug: null,
        status: 200,
        durationMs: expect.any(Number),
      },
    })
    expect(JSON.stringify(events)).not.toContain("sensitive-request-id")
    expect(JSON.stringify(events)).not.toContain("secret-client")
  })
})
