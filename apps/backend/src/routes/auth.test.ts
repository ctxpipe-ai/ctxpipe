import { Hono } from "hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  UI_PROXY_URL: process.env.UI_PROXY_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_BASE_URL: process.env.AUTH_BASE_URL,
  AUTH_ISSUER: process.env.AUTH_ISSUER,
}

async function createTestApp(options?: {
  /** When true, process.env and route `env` omit AUTH_ISSUER (PRM uses AS metadata issuer). */
  omitAuthIssuer?: boolean
}): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    const baseEnv = {
      AUTH_BASE_URL: "https://backend.example.com",
      DATABASE_URL: "postgres://localhost:5432/ctxpipe",
      UI_PROXY_URL: "http://ui:3002",
      AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      NODE_ENV: "test" as const,
      PORT: 3000,
      GRAPH_DB_URI: "redis://localhost:6379",
      GRAPH_DB_PROVIDER: "falkordb" as const,
    }
    c.set(
      "env",
      options?.omitAuthIssuer
        ? (baseEnv as AppEnv["Variables"]["env"])
        : ({
            ...baseEnv,
            AUTH_ISSUER: "https://auth.example.com",
          } as AppEnv["Variables"]["env"]),
    )
    c.set("user", null)
    c.set("session", null)
    c.set("oauthOrganizationId", null)
    c.set("orgApiKey", null)
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
    process.env.UI_PROXY_URL = "http://ui:3002"
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

  it("returns protected resource metadata for MCP endpoint", async () => {
    const app = await createTestApp()
    const response = await app.request(
      "/.well-known/oauth-protected-resource/mcp",
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.resource).toBe("https://backend.example.com/mcp")
    expect(body.authorization_servers).toEqual(["https://auth.example.com"])
  })

  it("aligns PRM authorization_servers with AS issuer when AUTH_ISSUER is unset", async () => {
    delete process.env.AUTH_ISSUER
    vi.resetModules()
    const app = await createTestApp({ omitAuthIssuer: true })

    const prRes = await app.request("/.well-known/oauth-protected-resource/mcp")
    const asRes = await app.request("/.well-known/oauth-authorization-server")
    expect(prRes.status).toBe(200)
    expect(asRes.status).toBe(200)

    const prBody = (await prRes.json()) as Record<string, unknown>
    const asBody = (await asRes.json()) as Record<string, unknown>
    const issuer = asBody.issuer
    expect(typeof issuer).toBe("string")
    expect(prBody.authorization_servers).toEqual([issuer])
  })

  it("serves the same MCP protected-resource document at the RFC 9728 root path", async () => {
    const app = await createTestApp()
    const root = await app.request("/.well-known/oauth-protected-resource")
    const mcp = await app.request("/.well-known/oauth-protected-resource/mcp")
    expect(root.status).toBe(200)
    expect(mcp.status).toBe(200)
    expect(await root.text()).toBe(await mcp.text())
  })

  it("serves authorization server metadata at RFC 8414 path-inserted /.well-known URLs", async () => {
    const app = await createTestApp()
    const oauthRoot = await app.request(
      "/.well-known/oauth-authorization-server",
    )
    const oauthInserted = await app.request(
      "/.well-known/oauth-authorization-server/mcp",
    )
    expect(oauthRoot.status).toBe(200)
    expect(oauthInserted.status).toBe(200)
    const oauthRootBody = await oauthRoot.text()
    expect(await oauthInserted.text()).toBe(oauthRootBody)

    const oidcRoot = await app.request("/.well-known/openid-configuration")
    const oidcInserted = await app.request(
      "/.well-known/openid-configuration/mcp",
    )
    const oidcAppended = await app.request(
      "/mcp/.well-known/openid-configuration",
    )
    expect(oidcRoot.status).toBe(200)
    expect(oidcInserted.status).toBe(200)
    expect(oidcAppended.status).toBe(200)
    const oidcRootBody = await oidcRoot.text()
    expect(await oidcInserted.text()).toBe(oidcRootBody)
    expect(await oidcAppended.text()).toBe(oidcRootBody)

    const oauthIssuerPath = await app.request(
      "/.well-known/oauth-authorization-server/.auth/api/v1/auth",
    )
    const oidcIssuerPath = await app.request(
      "/.well-known/openid-configuration/.auth/api/v1/auth",
    )
    expect(oauthIssuerPath.status).toBe(200)
    expect(oidcIssuerPath.status).toBe(200)
    expect(await oauthIssuerPath.text()).toBe(oauthRootBody)
    expect(await oidcIssuerPath.text()).toBe(oidcRootBody)
  })

  it("mounts oauth2 authorize endpoint under /.auth/api/v1/auth", async () => {
    const app = await createTestApp()
    const response = await app.request("/.auth/api/v1/auth/oauth2/authorize")

    expect(response.status).not.toBe(404)
  })

  it("mounts api-key endpoints under /.auth/api/v1/auth passthrough", async () => {
    const app = await createTestApp()
    const response = await app.request("/.auth/api/v1/auth/api-key/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test-key",
        expiresIn: null,
      }),
    })

    expect(response.status).not.toBe(404)
  })
})

describe("auth handler with the Better Auth infra plugin", () => {
  const identifyLookups: string[] = []
  const server = setupServer(
    http.get("https://kv.better-auth.com/identify/:requestId", ({ params }) => {
      identifyLookups.push(String(params.requestId))
      return new HttpResponse(null, { status: 404 })
    }),
    http.all("https://kv.better-auth.com/*", () =>
      HttpResponse.json(null, { status: 404 }),
    ),
    http.all("https://dash.better-auth.com/*", () => HttpResponse.json({})),
  )

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://localhost:5432/ctxpipe"
    process.env.UI_PROXY_URL = "http://ui:3002"
    process.env.AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
    process.env.AUTH_BASE_URL = "https://backend.example.com"
    process.env.AUTH_ISSUER = "https://auth.example.com"
    vi.stubEnv("BETTER_AUTH_API_KEY", "test-infra-key")
    vi.resetModules()
    identifyLookups.length = 0
    server.listen({ onUnhandledRequest: "bypass" })
  })

  afterEach(() => {
    server.close()
    vi.unstubAllEnvs()
    process.env.DATABASE_URL = previousEnv.DATABASE_URL
    process.env.UI_PROXY_URL = previousEnv.UI_PROXY_URL
    process.env.AUTH_SECRET = previousEnv.AUTH_SECRET
    process.env.AUTH_BASE_URL = previousEnv.AUTH_BASE_URL
    process.env.AUTH_ISSUER = previousEnv.AUTH_ISSUER
  })

  // The edge proxy adds X-Request-Id to each request. The infra plugin reads it
  // as a browser identify id and waits about 1 s on 404 retries per auth POST.
  it("does not look up the edge request id as a browser identification", async () => {
    const app = await createTestApp()
    await app.request("/.auth/api/v1/auth/sign-out", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "edge-request-id",
      },
      body: "{}",
    })

    expect(identifyLookups).toEqual([])
  })
})
