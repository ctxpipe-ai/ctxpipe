import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { oauthAccessTokens, organizations, users } from "../db/schema/auth.js"

const {
  getSessionMock,
  verifyApiKeyMock,
  authHandlerMock,
  jwtVerifyMock,
  createLocalJWKSetMock,
  getSystemDbMock,
  withOrgDbContextMock,
  testState,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  verifyApiKeyMock: vi.fn(),
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
      verifyApiKey: verifyApiKeyMock,
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

import { OAUTH_ORGANIZATION_CLAIM } from "./oauth-organization.js"
import {
  mcpOAuthProtectedResourceMetadataUrl,
  requireAuth,
  resetBearerJwksCacheForTests,
  withBearerAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "./withAuth.js"

function createMockDb(input: {
  orgRows?: Array<{ id: string; slug?: string }>
  membershipRows?: Array<{ id: string; slug: string }>
  userRows?: Array<{
    id: string
    name?: string | null
    email?: string | null
  }>
  tokenSessionRows?: Array<{
    session: { id: string; userId: string; activeOrganizationId?: string }
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
    referenceId?: string | null
    expiresAt: Date | null
  }>
}) {
  const orgRows = input.orgRows ?? []
  const membershipRows = input.membershipRows ?? []
  const userRows = input.userRows ?? []
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
          if (table === organizations) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => orgRows),
              })),
              innerJoin: vi.fn(() =>
                Object.assign(Promise.resolve(membershipRows), {
                  limit: vi.fn(async (limit: number) =>
                    membershipRows.slice(0, limit),
                  ),
                  where: vi.fn(() => ({
                    limit: vi.fn(async () => orgRows),
                  })),
                }),
              ),
            }
          }
          if (table === users) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => userRows),
              })),
            }
          }
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
    c.set("oauthOrganizationId", null)
    c.set("orgApiKey", null)
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
    withMcpBearerAuth,
    withCookieAuth,
    withOrgApiKeyAuth,
    requireAuth,
    withNetworkOrgContext,
  )
  app.post("/mcp", (c) =>
    c.json({
      user: c.get("user"),
      session: c.get("session"),
      orgApiKey: c.get("orgApiKey"),
      orgSlug: c.get("orgSlug"),
      orgId: c.get("orgId"),
    }),
  )
  return app
}

function resetAuthMocks(): void {
  vi.clearAllMocks()
  resetBearerJwksCacheForTests()
  testState.db = createMockDb({})
  getSystemDbMock.mockReset()
  getSystemDbMock.mockImplementation(() => testState.db as never)
  withOrgDbContextMock.mockReset()
  withOrgDbContextMock.mockImplementation(
    async (_orgId: string, handler: (db: unknown) => Promise<unknown>) =>
      handler(testState.db),
  )
  createLocalJWKSetMock.mockReset()
  createLocalJWKSetMock.mockReturnValue("mock-jwks-set")
  jwtVerifyMock.mockReset()
  authHandlerMock.mockReset()
  authHandlerMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  )
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue(null)
  verifyApiKeyMock.mockReset()
  verifyApiKeyMock.mockResolvedValue({
    valid: false,
    error: { message: "KEY_NOT_FOUND", code: "KEY_NOT_FOUND" },
    key: null,
  })
}

describe("auth middleware composition", () => {
  beforeEach(() => {
    resetAuthMocks()
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
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
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
      orgApiKey: null,
      orgSlug: "acme",
      orgId: "org_cookie",
    })
    expect(jwtVerifyMock).not.toHaveBeenCalled()
    expect(withOrgDbContextMock).not.toHaveBeenCalled()
  })

  it("does not hold a request-wide org transaction on /mcp", async () => {
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
    expect(withOrgDbContextMock).not.toHaveBeenCalled()
  })

  it("rejects an unbound bare MCP request even with one membership", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })
    testState.db = createMockDb({
      membershipRows: [{ id: "org_solo", slug: "solo" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", { method: "POST" })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: {
        message: expect.stringContaining("not bound to an organization"),
      },
    })
  })

  it("does not infer an unbound OAuth organization from mutable session state", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: {
        id: "sess_cookie",
        userId: "user_cookie",
        activeOrganizationId: "org_beta",
      },
    })
    testState.db = createMockDb({
      membershipRows: [
        { id: "org_alpha", slug: "alpha" },
        { id: "org_beta", slug: "beta" },
      ],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", { method: "POST" })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: {
        message: expect.stringContaining("not bound to an organization"),
      },
    })
  })

  it("rejects an unbound multi-organization session", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })
    testState.db = createMockDb({
      membershipRows: [
        { id: "org_alpha", slug: "alpha" },
        { id: "org_beta", slug: "beta" },
      ],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", { method: "POST" })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: {
        message: expect.stringContaining("Reconnect ctxpipe"),
      },
    })
  })

  it("rejects an authenticated user who is not a member of the requested org", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_outsider", email: "outsider@example.com" },
      session: { id: "sess_outsider", userId: "user_outsider" },
    })
    testState.db = createMockDb({ orgRows: [] })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=private-org", {
      method: "POST",
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
    expect(withOrgDbContextMock).not.toHaveBeenCalled()
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
      orgApiKey: null,
      orgSlug: "acme",
      orgId: "org_token",
    })
  })

  it("uses the organization frozen into a JWT grant instead of mutable session state", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "user_oauth",
        sid: "sess_oauth",
        [OAUTH_ORGANIZATION_CLAIM]: "org_bound",
      },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: {
            id: "sess_oauth",
            userId: "user_oauth",
            activeOrganizationId: "org_other",
          },
          user: { id: "user_oauth", email: "oauth@example.com" },
        },
      ],
      orgRows: [{ id: "org_bound", slug: "bound" }],
      membershipRows: [
        { id: "org_bound", slug: "bound" },
        { id: "org_other", slug: "other" },
      ],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      orgSlug: "bound",
      orgId: "org_bound",
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("rejects an explicit orgSlug that conflicts with the JWT grant", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "user_oauth",
        sid: "sess_oauth",
        [OAUTH_ORGANIZATION_CLAIM]: "org_bound",
      },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_oauth", userId: "user_oauth" },
          user: { id: "user_oauth", email: "oauth@example.com" },
        },
      ],
      orgRows: [{ id: "org_bound", slug: "bound" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=other", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(404)
    expect(withOrgDbContextMock).not.toHaveBeenCalled()
  })

  it("uses the organization frozen into an opaque OAuth grant", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    testState.db = createMockDb({
      opaqueTokenRows: [
        {
          token: "hashed-token",
          userId: "user_opaque",
          sessionId: "sess_opaque",
          referenceId: "org_bound",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
      tokenSessionRows: [
        {
          session: {
            id: "sess_opaque",
            userId: "user_opaque",
            activeOrganizationId: "org_other",
          },
          user: { id: "user_opaque", email: "opaque@example.com" },
        },
      ],
      orgRows: [{ id: "org_bound", slug: "bound" }],
      membershipRows: [
        { id: "org_bound", slug: "bound" },
        { id: "org_other", slug: "other" },
      ],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer opaque-random-32-chars" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      orgSlug: "bound",
      orgId: "org_bound",
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("accepts an organization-bound JWT after its browser session is deleted", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "user_offline",
        sid: "sess_deleted",
        [OAUTH_ORGANIZATION_CLAIM]: "org_bound",
      },
    })
    testState.db = createMockDb({
      tokenSessionRows: [],
      bearerSubFallbackRows: [],
      userRows: [{ id: "user_offline", email: "offline@example.com" }],
      orgRows: [{ id: "org_bound", slug: "bound" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: "user_offline", email: "offline@example.com" },
      session: null,
      orgSlug: "bound",
      orgId: "org_bound",
    })
  })

  it("accepts an organization-bound opaque grant after its browser session is deleted", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    testState.db = createMockDb({
      opaqueTokenRows: [
        {
          token: "hashed-token",
          userId: "user_offline",
          sessionId: "sess_deleted",
          referenceId: "org_bound",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
      tokenSessionRows: [],
      bearerSubFallbackRows: [],
      userRows: [{ id: "user_offline", email: "offline@example.com" }],
      orgRows: [{ id: "org_bound", slug: "bound" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer opaque-random-32-chars" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: "user_offline", email: "offline@example.com" },
      session: null,
      orgSlug: "bound",
      orgId: "org_bound",
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
      orgApiKey: null,
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
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"',
    )
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
    // Auth API mocks stay at the Better Auth boundary (beforeEach defaults:
    // no session, verifyApiKey invalid). This case asserts the real
    // WWW-Authenticate header built from AUTH_BASE_URL once that path 401s.
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

describe("org API-key principal", () => {
  function createMcpPrincipalApp(): Hono<AppEnv> {
    const app = createBaseApp()
    app.use(
      "/mcp",
      withMcpBearerAuth,
      withCookieAuth,
      withOrgApiKeyAuth,
      requireAuth,
    )
    app.post("/mcp", (c) =>
      c.json({
        user: c.get("user"),
        session: c.get("session"),
        orgApiKey: c.get("orgApiKey"),
      }),
    )
    return app
  }

  function createRestPrincipalApp(): Hono<AppEnv> {
    const app = createBaseApp()
    app.use(
      "/:orgSlug/api/v1/conversations",
      withCookieAuth,
      withBearerAuth,
      requireAuth,
    )
    app.get("/:orgSlug/api/v1/conversations", (c) =>
      c.json({
        ok: true,
        user: c.get("user"),
        session: c.get("session"),
        orgApiKey: c.get("orgApiKey"),
      }),
    )
    return app
  }

  function mockOrgKey(input?: {
    id?: string
    referenceId?: string
    configId?: string
  }) {
    verifyApiKeyMock.mockResolvedValueOnce({
      valid: true,
      error: null,
      key: {
        id: input?.id ?? "key_org",
        configId: input?.configId ?? "organization",
        referenceId: input?.referenceId ?? "org_acme",
      },
    })
  }

  function mockInvalidKey(code: string) {
    verifyApiKeyMock.mockResolvedValueOnce({
      valid: false,
      error: { message: code, code },
      key: null,
    })
  }

  function mockPersonalApiKeySession() {
    getSessionMock.mockImplementation(
      async ({ headers }: { headers: Headers }) => {
        if (headers.get("x-api-key") !== "ctxp_user_key") return null
        return {
          user: { id: "user_api_key", email: "api-key@example.com" },
          session: { id: "sess_api_key", userId: "user_api_key" },
        }
      },
    )
  }

  beforeEach(() => {
    resetAuthMocks()
  })

  it("user x-api-key still sets user and session", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
    })

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_user_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
      orgApiKey: null,
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("org x-api-key sets orgApiKey, leaves user and session null, and requireAuth on /mcp passes", async () => {
    mockOrgKey()

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: null,
      session: null,
      orgApiKey: {
        id: "key_org",
        orgId: "org_acme",
        configId: "organization",
      },
    })
    expect(verifyApiKeyMock).toHaveBeenCalledTimes(1)
    expect(verifyApiKeyMock.mock.calls[0]?.[0]).toEqual({
      body: { key: "ctxp_org_key" },
    })
  })

  it("org x-api-key still authenticates /mcp when getSession throws", async () => {
    getSessionMock.mockRejectedValueOnce(new Error("INVALID_API_KEY"))
    mockOrgKey()

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: null,
      session: null,
      orgApiKey: { orgId: "org_acme", configId: "organization" },
    })
  })

  it("org x-api-key on a REST path returns 401 without verifying the key", async () => {
    const app = createRestPrincipalApp()
    const response = await app.request("/acme/api/v1/conversations", {
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("user x-api-key still authenticates REST as that user", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
    })

    const app = createRestPrincipalApp()
    const response = await app.request("/acme/api/v1/conversations", {
      headers: { "x-api-key": "ctxp_user_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
      orgApiKey: null,
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("Bearer API keys do not authenticate REST routes", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    mockPersonalApiKeySession()

    const app = createRestPrincipalApp()
    const response = await app.request("/acme/api/v1/conversations", {
      headers: { authorization: "Bearer ctxp_user_key" },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("Bearer OAuth is unchanged and does not set orgApiKey", async () => {
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

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
      orgApiKey: null,
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("OAuth Bearer takes precedence over a simultaneous org x-api-key", async () => {
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
    mockOrgKey()

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer header.payload.signature",
        "x-api-key": "ctxp_org_key",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
      orgApiKey: null,
    })
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("does not ignore an invalid Bearer when a cookie session is present", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    getSessionMock.mockImplementation(
      async ({ headers }: { headers: Headers }) =>
        headers.get("x-api-key")
          ? null
          : {
              user: { id: "user_cookie", email: "cookie@example.com" },
              session: { id: "sess_cookie", userId: "user_cookie" },
            },
    )
    mockInvalidKey("KEY_NOT_FOUND")

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-bearer",
        cookie: "session=present",
      },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
  })

  it("Bearer personal API key sets user and session", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    mockPersonalApiKeySession()

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer ctxp_user_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
      orgApiKey: null,
    })
  })

  it("Bearer org API key sets orgApiKey without a user session", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    getSessionMock.mockResolvedValue(null)
    mockOrgKey()

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer ctxp_org_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: null,
      session: null,
      orgApiKey: {
        id: "key_org",
        orgId: "org_acme",
        configId: "organization",
      },
    })
  })

  it("Bearer org API key takes precedence over a simultaneous x-api-key", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    mockOrgKey()

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer ctxp_org_key",
        "x-api-key": "ctxp_other_key",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: null,
      session: null,
      orgApiKey: { id: "key_org", orgId: "org_acme" },
    })
    expect(verifyApiKeyMock).toHaveBeenCalledTimes(1)
  })

  it("Bearer that is neither OAuth nor API key returns 401", async () => {
    testState.db = createMockDb({ opaqueTokenRows: [] })
    getSessionMock.mockResolvedValue(null)
    mockInvalidKey("KEY_NOT_FOUND")

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer ctxp_looks_like_an_api_key" },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
  })

  it("invalid org key returns 401", async () => {
    mockInvalidKey("KEY_NOT_FOUND")

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_bogus" },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
  })

  it("expired org key returns 401", async () => {
    mockInvalidKey("KEY_EXPIRED")

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_expired" },
    })

    expect(response.status).toBe(401)
  })

  it("disabled org key returns 401", async () => {
    mockInvalidKey("KEY_DISABLED")

    const app = createMcpPrincipalApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_disabled" },
    })

    expect(response.status).toBe(401)
  })
})

describe("org API-key tenant binding", () => {
  function mockOrgKey(input?: { referenceId?: string }) {
    getSessionMock.mockResolvedValue(null)
    verifyApiKeyMock.mockResolvedValueOnce({
      valid: true,
      error: null,
      key: {
        id: "key_org",
        configId: "organization",
        referenceId: input?.referenceId ?? "org_acme",
      },
    })
  }

  beforeEach(() => {
    resetAuthMocks()
  })

  it("org x-api-key on /mcp binds the key's org without orgSlug or membership", async () => {
    mockOrgKey()
    testState.db = createMockDb({
      orgRows: [{ id: "org_acme", slug: "acme" }],
      membershipRows: [],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: null,
      session: null,
      orgApiKey: {
        id: "key_org",
        orgId: "org_acme",
        configId: "organization",
      },
      orgSlug: "acme",
      orgId: "org_acme",
    })
  })

  it("org x-api-key still works after the minter has no membership and does not impersonate them", async () => {
    mockOrgKey()
    testState.db = createMockDb({
      orgRows: [{ id: "org_acme", slug: "acme" }],
      membershipRows: [],
      userRows: [{ id: "user_minter", email: "minter@example.com" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      user: null,
      session: null,
      orgApiKey: {
        id: "key_org",
        orgId: "org_acme",
        configId: "organization",
      },
      orgSlug: "acme",
      orgId: "org_acme",
    })
    expect(JSON.stringify(body)).not.toContain("user_minter")
  })

  it("org x-api-key accepts a matching orgSlug", async () => {
    mockOrgKey()
    testState.db = createMockDb({
      orgRows: [{ id: "org_acme", slug: "acme" }],
      membershipRows: [],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      orgSlug: "acme",
      orgId: "org_acme",
      orgApiKey: { orgId: "org_acme" },
    })
  })

  it("org x-api-key rejects a mismatched orgSlug with 404", async () => {
    mockOrgKey()
    testState.db = createMockDb({
      orgRows: [{ id: "org_acme", slug: "acme" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=other", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
  })

  it("org x-api-key returns 404 when the bound org is missing", async () => {
    mockOrgKey()
    testState.db = createMockDb({ orgRows: [] })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_org_key" },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
  })

  it("user x-api-key still requires orgSlug", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
    })
    testState.db = createMockDb({
      membershipRows: [{ id: "org_solo", slug: "solo" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "x-api-key": "ctxp_user_key" },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: {
        message: expect.stringContaining("not bound to an organization"),
      },
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("user x-api-key still authenticates MCP as that user when orgSlug matches membership", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
    })
    testState.db = createMockDb({
      orgRows: [{ id: "org_acme" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp?orgSlug=acme", {
      method: "POST",
      headers: { "x-api-key": "ctxp_user_key" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_api_key", email: "api-key@example.com" },
      session: { id: "sess_api_key", userId: "user_api_key" },
      orgApiKey: null,
      orgSlug: "acme",
      orgId: "org_acme",
    })
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("unbound OAuth grant without orgSlug still returns 400", async () => {
    getSessionMock.mockResolvedValueOnce(null)
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "user_oauth", sid: "sess_oauth" },
    })
    testState.db = createMockDb({
      tokenSessionRows: [
        {
          session: { id: "sess_oauth", userId: "user_oauth" },
          user: { id: "user_oauth", email: "oauth@example.com" },
        },
      ],
      membershipRows: [{ id: "org_solo", slug: "solo" }],
    })

    const app = createComposedTestApp()
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: {
        message: expect.stringContaining("not bound to an organization"),
      },
    })
  })
})
