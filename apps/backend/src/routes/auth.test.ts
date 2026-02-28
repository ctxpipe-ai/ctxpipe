import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  UI_PROXY_URL: process.env.UI_PROXY_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_BASE_URL: process.env.AUTH_BASE_URL,
  AUTH_ISSUER: process.env.AUTH_ISSUER,
}

async function createTestApp(): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set(
      "env",
      {
        AUTH_BASE_URL: "https://backend.example.com",
        AUTH_ISSUER: "https://auth.example.com",
      } as AppEnv["Variables"]["env"],
    )
    c.set("user", null)
    c.set("session", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })

  const { registerAuthRoutes } = await import("./auth.js")
  registerAuthRoutes(app)
  return app
}

describe("auth metadata routes", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = "postgres://localhost:5432/ctxpipe"
    process.env.UI_PROXY_URL = "http://ui-bun:3002"
    process.env.AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
    process.env.AUTH_BASE_URL = "https://backend.example.com"
    process.env.AUTH_ISSUER = "https://auth.example.com"
    vi.resetModules()
  })

  afterEach(() => {
    process.env.DATABASE_URL = previousEnv.DATABASE_URL
    process.env.UI_PROXY_URL = previousEnv.UI_PROXY_URL
    process.env.AUTH_SECRET = previousEnv.AUTH_SECRET
    process.env.AUTH_BASE_URL = previousEnv.AUTH_BASE_URL
    process.env.AUTH_ISSUER = previousEnv.AUTH_ISSUER
  })

  it("returns protected resource metadata for org MCP endpoint", async () => {
    const app = await createTestApp()
    const response = await app.request(
      "/.well-known/oauth-protected-resource/acme/mcp",
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.resource).toBe("https://backend.example.com/acme/mcp")
    expect(body.authorization_servers).toEqual(["https://auth.example.com"])
  })

  it("mounts oauth2 authorize endpoint under /.auth/api/v1", async () => {
    const app = await createTestApp()
    const response = await app.request("/.auth/api/v1/oauth2/authorize")

    expect(response.status).not.toBe(404)
  })
})
