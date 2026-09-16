import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const {
  withCookieAuthMock,
  withOrgApiKeyAuthMock,
  withBearerAuthMock,
  requireAuthMock,
  withOrgContextMock,
} = vi.hoisted(() => ({
  withCookieAuthMock: vi.fn(),
  withOrgApiKeyAuthMock: vi.fn(),
  withBearerAuthMock: vi.fn(),
  requireAuthMock: vi.fn(),
  withOrgContextMock: vi.fn(),
}))

vi.mock("../../auth/withAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/withAuth.js")>()
  return {
    ...actual,
    withCookieAuth: withCookieAuthMock,
    withOrgApiKeyAuth: withOrgApiKeyAuthMock,
    withBearerAuth: withBearerAuthMock,
    requireAuth: requireAuthMock,
    withNetworkOrgContext: withOrgContextMock,
  }
})

vi.mock("./repositories.js", () => ({
  repositoryRoutes: new OpenAPIHono<AppEnv>(),
}))
vi.mock("./conversations.js", () => ({
  conversationRoutes: new OpenAPIHono<AppEnv>(),
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: vi.fn() },
  runWorkflowWithWorkerWake: vi.fn(),
}))

import { registerV1Routes } from "./index.js"

describe("registerV1Routes auth middleware chain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withCookieAuthMock.mockImplementation(async (_c, next) => next())
    withOrgApiKeyAuthMock.mockImplementation(async (_c, next) => next())
    withBearerAuthMock.mockImplementation(async (_c, next) => next())
    requireAuthMock.mockImplementation(async (_c, next) => next())
    withOrgContextMock.mockImplementation(async (_c, next) => next())
  })

  it("runs cookie + bearer + requireAuth + org middleware for v1 paths", async () => {
    const app = new OpenAPIHono<AppEnv>()
    registerV1Routes(app)

    const orgResponse = await app.request("/acme/api/v1/not-a-route")
    const nonOrgResponse = await app.request("/api/v1/not-a-route")

    expect(orgResponse.status).toBe(404)
    expect(nonOrgResponse.status).toBe(404)
    expect(withCookieAuthMock).toHaveBeenCalledTimes(2)
    expect(withOrgApiKeyAuthMock).not.toHaveBeenCalled()
    expect(withBearerAuthMock).toHaveBeenCalledTimes(2)
    expect(requireAuthMock).toHaveBeenCalledTimes(2)
    expect(withOrgContextMock).toHaveBeenCalledTimes(1)
  })
})
