import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const {
  withCookieAuthMock,
  withBearerAuthMock,
  requireAuthMock,
  withOrgContextMock,
  requireOrgAdminOrOwnerMock,
  withNetworkOrgContextMock,
} = vi.hoisted(() => ({
  withCookieAuthMock: vi.fn(),
  withBearerAuthMock: vi.fn(),
  requireAuthMock: vi.fn(),
  withOrgContextMock: vi.fn(),
  requireOrgAdminOrOwnerMock: vi.fn(),
  withNetworkOrgContextMock: vi.fn(),
}))

vi.mock("../../auth/withAuth.js", () => ({
  withCookieAuth: withCookieAuthMock,
  withBearerAuth: withBearerAuthMock,
  requireAuth: requireAuthMock,
  withOrgContext: withOrgContextMock,
  requireOrgAdminOrOwner: requireOrgAdminOrOwnerMock,
  withNetworkOrgContext: withNetworkOrgContextMock,
}))

vi.mock("./repositories.js", () => ({
  repositoryRoutes: new OpenAPIHono<AppEnv>(),
}))
vi.mock("./conversations.js", () => ({
  conversationRoutes: new OpenAPIHono<AppEnv>(),
}))

import { registerV1Routes } from "./index.js"

describe("registerV1Routes auth middleware chain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withCookieAuthMock.mockImplementation(async (_c, next) => next())
    withBearerAuthMock.mockImplementation(async (_c, next) => next())
    requireAuthMock.mockImplementation(async (_c, next) => next())
    withOrgContextMock.mockImplementation(async (_c, next) => next())
  })

  it("runs cookie + bearer + requireAuth + org middleware for v1 paths", async () => {
    const app = new OpenAPIHono<AppEnv>()
    registerV1Routes(app)

    // `OpenAPIHono#fetch` returns a `Context` in this harness (not a `Response`),
    // and the status setter is a function. Use `.notFound()` to obtain the
    // finalized `Response` and assert on that.
    const ctx = (await app.fetch(
      new Request("http://example.test/acme/api/v1/not-a-route"),
    )) as unknown as { notFound?: () => Response }
    const res = ctx.notFound?.()

    expect(res?.status).toBe(404)
    expect(withCookieAuthMock).toHaveBeenCalledTimes(1)
    expect(withBearerAuthMock).toHaveBeenCalledTimes(1)
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
    expect(withNetworkOrgContextMock).toHaveBeenCalledTimes(1)
  })
})
