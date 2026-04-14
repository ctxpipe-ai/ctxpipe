import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

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

import {
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
}) {
  const orgRows = input.orgRows ?? []
  const tokenSessionRows = input.tokenSessionRows ?? []

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
              })),
            })),
          })),
        }
      }

      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => orgRows),
          })),
        })),
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
    authHandlerMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
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
      headers: { authorization: "Bearer token-value" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
    })
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1)
    expect(authHandlerMock).toHaveBeenCalledTimes(1)
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
      headers: { authorization: "Bearer token-one" },
    })
    await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer token-two" },
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
      headers: { authorization: "Bearer token-value" },
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
      headers: { authorization: "Bearer token-value" },
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
      headers: { authorization: "Bearer token-value" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: "user_token", email: "token@example.com" },
      session: { id: "sess_token", userId: "user_token" },
      orgSlug: "acme",
      orgId: "org_token",
    })
  })
})
