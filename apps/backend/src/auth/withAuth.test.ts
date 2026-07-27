import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { oauthAccessTokens } from "../db/schema/auth.js"

const {
  getSessionMock,
  authHandlerMock,
  jwtVerifyMock,
  createLocalJWKSetMock,
  getSystemDbMock,
  withOrgDbContextMock,
  testState,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  authHandlerMock: vi.fn(),
  jwtVerifyMock: vi.fn(),
  createLocalJWKSetMock: vi.fn(),
  getSystemDbMock: vi.fn(),
  withOrgDbContextMock: vi.fn(),
  testState: {
    db: null as unknown,
  },
}))

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>()
  return {
    ...actual,
    createLocalJWKSet: createLocalJWKSetMock,
    jwtVerify: jwtVerifyMock,
  }
})

vi.mock("./config.js", () => ({
  getAuth: () => ({
    api: {
      getSession: getSessionMock,
    },
    handler: authHandlerMock,
  }),
}))

vi.mock("../db/client.js", () => ({
  getSystemDb: getSystemDbMock,
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../observability/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}))

import {
  mcpOAuthProtectedResourceMetadataUrl,
  requireAuth,
  resetBearerJwksCacheForTests,
  withBearerAuth,
  withCookieAuth,
  withNetworkOrgContext,
} from "./withAuth.js"

function createMockDb(input: {
  orgRows?: Array<{ id: string }>
  tokenSessionRows?: Array<{
    session: { id: string; userId: string }
    user: { id: string; name?: string | null; email?: string | null }
  }>
  /** When bearer JWT has no `sid`, `withBearerAuth` loads latest session by user id (`sub`). */
  bearerSubFallbackRows?: Array<{
    session: { id: string; userId: string }
    user: { id: string; name?: string | null; email?: string | null }
  }>
  /** For opaque (non-JWT) bearer tokens, `withBearerAuth` looks up `oauth_access_tokens.token`. */
  opaqueTokenRows?: Array<{
    token: string
    userId: string | null
    sessionId: string | null
    expiresAt: Date | null
  }>
}) {
  const orgRows = input.orgRows ?? []
  const tokenSessionRows = input.tokenSessionRows ?? []
  const bearerSubFallbackRows = input.bearerSubFallbackRows ?? tokenSessionRows
  const opaqueTokenRows = input.opaqueTokenRows ?? []

  return {
    select: vi.fn((fields?: unknown) => {
      const maybeTokenFields = fields as Record<string, unknown> | undefined
      if (
        maybeTokenFields &&
        "session" in maybeTokenFields &&
        "user" in maybeTokenFields
      ) {
        return {
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(async () => tokenSessionRows),
                orderBy: vi.fn(() => ({
                  limit: vi.fn(async () => bearerSubFallbackRows),
                })),
              })),
            })),
          })),
        }
      }

      return {
        from: vi.fn((table: unknown) => {
          const rows = table === oauthAccessTokens ? opaqueTokenRows : orgRows
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => rows),
            })),
          }
        }),
      }
    }),
  }
}

function createBaseApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", {
      AUTH_BASE_URL: "https://backend.example.com",
      AUTH_ISSUER: "https://auth.example.com",
    } as AppEnv["Variables"]["env"])
    c.set("user", null)
    c.set("session", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  return app
}

function createComposedTestApp(): Hono<AppEnv> {
  const app = createBaseApp()
  app.use(
    "/mcp",
    withCookieAuth,
    withBearerAuth,
    requireAuth,
    withNetworkOrgContext,
  )
  app.post("/mcp", (c) =>
    c.json({
      user: c.get("user"),
      session: c.get("session"),
      orgSlug: c.get("orgSlug"),
      orgId: c.get("orgId"),
    }),
  )
  return app
}

describe("auth middleware composition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetBearerJwksCacheForTests()
    getSystemDbMock.mockImplementation(() => testState.db as never)
    withOrgDbContextMock.mockImplementation(
      async (_orgId: string, handler: (db: unknown) => Promise<unknown>) =>
        handler(testState.db),
    )
    createLocalJWKSetMock.mockReturnValue("mock-jwks-set")
    authHandlerMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  })

  it("withCookieAuth sets user and session from cookie session", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })

    const app = createBaseApp()
    app.use("/mcp", withCookieAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    const response = await app.request("/mcp", { method: "POST" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })
  })

  it("withCookieAuth resolves session via x-api-key header", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
    })

    const app = createBaseApp()
    app.use("/mcp", withCookieAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_test_api_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
    })
    expect(getSessionMock).toHaveBeenCalledTimes(1)
    const firstCall = getSessionMock.mock.calls[0]
    const headers = firstCall?.[0]?.headers as Headers | undefined
    expect(headers?.get("x-api-key")).toBe("ctxp_test_api_key")
  })

  it("withBearerAuth sets user and session from bearer token", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "token_sub", sid: "sess_token" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_token", userId: "user_token" },
          user: { id: "user_token", email: "token@example.com" },
        },
      ],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
    })
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1)
    expect(authHandlerMock).toHaveBeenCalledTimes(1)
  })

  it("withBearerAuth resolves user from sub when JWT omits sid (MCP OAuth clients)", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "user_oauth_only" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [],
      bearerSubFallbackRows: [
        {
          session: { id: "sess_latest", userId: "user_oauth_only" },
          user: { id: "user_oauth_only", email: "oauth@example.com" },
        },
      ],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_oauth_only", email: "oauth@example.com" },
      session: { id: "sess_latest", userId: "user_oauth_only" },
    })
  })

  it("withBearerAuth returns 401 when JWT has sub but no sid and no DB session for user", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "user_unknown" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [],
      bearerSubFallbackRows: [],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) => c.text("ok"))

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(401)
  })

  it("withBearerAuth validates an opaque (non-JWT) OAuth access token via oauth_access_tokens", async () => {
    testState.db = createMockDb({
      opaqueTokenRows: [
        {
          token: "hashed-token",
          userId: "user_opaque",
          sessionId: "sess_opaque",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
      tokenSessionRows: [
        {
          session: { id: "sess_opaque", userId: "user_opaque" },
          user: { id: "user_opaque", email: "opaque@example.com" },
        },
      ],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer opaque-random-32-chars" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_opaque", email: "opaque@example.com" },
      session: { id: "sess_opaque", userId: "user_opaque" },
    })
    expect(jwtVerifyMock).not.toHaveBeenCalled()
    expect(authHandlerMock).not.toHaveBeenCalled()
  })

  it("withBearerAuth returns 401 for an unknown opaque access token", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) => c.text("ok"))

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer does-not-exist" },
    })

    expect(response.status).toBe(401)
    expect(jwtVerifyMock).not.toHaveBeenCalled()
  })

  it("withBearerAuth returns 401 for an expired opaque access token", async () => {
    testState.db = createMockDb({
      opaqueTokenRows: [
        {
          token: "hashed-token",
          userId: "user_opaque",
          sessionId: "sess_opaque",
          expiresAt: new Date(Date.now() - 60_000),
        },
      ],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) => c.text("ok"))

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer expired-opaque" },
    })

    expect(response.status).toBe(401)
  })

  it("withBearerAuth uses cached JWKS for a second request (single JWKS fetch)", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "token_sub", sid: "sess_token" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_token", userId: "user_token" },
          user: { id: "user_token", email: "token@example.com" },
        },
      ],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer one.two.three" },
    })
    await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer four.five.six" },
    })

    expect(authHandlerMock).toHaveBeenCalledTimes(1)
    expect(jwtVerifyMock).toHaveBeenCalledTimes(2)
  })

  it("withBearerAuth refetches JWKS when verification fails then succeeds on retry", async () => {
    const sigErr = new Error("bad sig")
    Object.assign(sigErr, { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" })
    jwtVerifyMock.mockRejectedValueOnce(sigErr).mockResolvedValueOnce({
      payload: { sub: "token_sub", sid: "sess_token" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_token", userId: "user_token" },
          user: { id: "user_token", email: "token@example.com" },
        },
      ],
    })

    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    )

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(authHandlerMock).toHaveBeenCalledTimes(2)
    expect(jwtVerifyMock).toHaveBeenCalledTimes(2)
  })

  it("composed middleware sets user, session, orgSlug and orgId for cookie auth", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })
    testState.db = createMockDb({
      orgRows: [{ id: "org_cookie" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=acme", { method: "POST" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
      orgSlug: "acme",
      orgId: "org_cookie",
    })
    expect(jwtVerifyMock).not.toHaveBeenCalled()
  })

  it("composed middleware uses bearer auth for bearer-only requests", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "token_sub", sid: "sess_token" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_token", userId: "user_token" },
          user: { id: "user_token", email: "token@example.com" },
        },
      ],
      orgRows: [{ id: "org_token" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
      orgSlug: "acme",
      orgId: "org_token",
    })
  })

  it("composed middleware lets bearer override cookie when both are present", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "token_sub", sid: "sess_token" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_token", userId: "user_token" },
          user: { id: "user_token", email: "token@example.com" },
        },
      ],
      orgRows: [{ id: "org_token" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
      orgSlug: "acme",
      orgId: "org_token",
    })
  })

  it("requireAuth on /mcp includes resource_metadata in WWW-Authenticate", async () => {
    const app = createBaseApp()
    app.use("/mcp", requireAuth)
    app.post("/mcp", (c) => c.text("ok"))
    const response = await app.request("/mcp", { method: "POST" })
    expect(response.status).toBe(401)
    const www = response.headers.get("WWW-Authenticate")
    expect(www).not.toContain("error=")
    expect(www).toContain("resource_metadata=")
    expect(www).toContain(
      mcpOAuthProtectedResourceMetadataUrl("https://backend.example.com"),
    )
  })

  it("requireAuth on /mcp with non-empty Bearer uses invalid_token in WWW-Authenticate", async () => {
    const app = createBaseApp()
    app.use("/mcp", requireAuth)
    app.post("/mcp", (c) => c.text("ok"))
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer opaque-but-unverified" },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"')
  })

  it("requireAuth on non-MCP path omits resource_metadata", async () => {
    const app = createBaseApp()
    app.use("/api/v1/onboarding", requireAuth)
    app.post("/api/v1/onboarding", (c) => c.text("ok"))
    const response = await app.request("/api/v1/onboarding", { method: "POST" })
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).not.toContain(
      "resource_metadata",
    )
  })

  it("withBearerAuth 401 on /mcp includes resource_metadata", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    const app = createBaseApp()
    app.use("/mcp", withBearerAuth)
    app.post("/mcp", (c) => c.text("ok"))
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer bad" },
    })
    expect(response.status).toBe(401)
    const www = response.headers.get("WWW-Authenticate")
    expect(www).toContain("resource_metadata=")
    expect(www).toContain(
      mcpOAuthProtectedResourceMetadataUrl("https://backend.example.com"),
    )
  })
})
