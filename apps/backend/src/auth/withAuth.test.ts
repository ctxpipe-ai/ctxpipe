import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const {
  getSessionMock,
  authHandlerMock,
  jwtVerifyMock,
  createLocalJWKSetMock,
  withDbContextMock,
  testState,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  authHandlerMock: vi.fn(),
  jwtVerifyMock: vi.fn(),
  createLocalJWKSetMock: vi.fn(),
  withDbContextMock: vi.fn(),
  testState: {
    db: null as unknown,
  },
}))

vi.mock("jose", () => ({
  createLocalJWKSet: createLocalJWKSetMock,
  jwtVerify: jwtVerifyMock,
}))

vi.mock("./config.js", () => ({
  createBetterAuth: () => ({
    api: {
      getSession: getSessionMock,
    },
    handler: authHandlerMock,
  }),
}))

vi.mock("../db/client.js", () => ({
  withDbContext: withDbContextMock,
}))

import { withAuth } from "./withAuth.js"

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
      const maybeTokenFields = fields as
        | Record<string, unknown>
        | undefined
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

function createTestApp(): Hono<AppEnv> {
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
  app.use("/mcp", withAuth)
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

describe("withAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withDbContextMock.mockImplementation(async (handler) => {
      return handler(testState.db as never)
    })
    createLocalJWKSetMock.mockReturnValue("mock-jwks-set")
    authHandlerMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })

  it("sets user, session, orgSlug and orgId for cookie session branch", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user_cookie", email: "cookie@example.com" },
      session: { id: "sess_cookie", userId: "user_cookie" },
    })
    testState.db = createMockDb({
      orgRows: [{ id: "org_cookie" }],
    })

    const app = createTestApp()
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

  it("sets user, session, orgSlug and orgId for bearer token branch", async () => {
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

    const app = createTestApp()
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
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1)
    expect(authHandlerMock).toHaveBeenCalledTimes(1)
  })
})
