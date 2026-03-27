import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"

const jwtVerifyMock = vi.hoisted(() => vi.fn())
const createRemoteJwkSetMock = vi.hoisted(() => vi.fn())

vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: createRemoteJwkSetMock,
}))

const getAtlassianInstanceByCloudIdMock = vi.hoisted(() => vi.fn())
const upsertForgeInstallationFromEventMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/atlassian-connector.js", () => ({
  getAtlassianInstanceByCloudId: getAtlassianInstanceByCloudIdMock,
  upsertForgeInstallationFromEvent: upsertForgeInstallationFromEventMock,
}))

import { registerAtlassianWebhookRoute } from "./atlassian.js"

describe("POST /api/v1/webhook/atlassian/forge", () => {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe",
    AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
  } as Record<string, string | undefined>)

  beforeEach(() => {
    vi.clearAllMocks()
    createRemoteJwkSetMock.mockReturnValue({})
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "forge-event" } })
    getAtlassianInstanceByCloudIdMock.mockResolvedValue({
      orgId: "org_1",
      cloudId: "cloud_1",
      siteUrl: "https://acme.atlassian.net",
    })
    upsertForgeInstallationFromEventMock.mockResolvedValue({
      id: "fgi_1",
      orgId: "org_1",
    })
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as unknown as AppEnv["Variables"]["log"])
      await next()
    })
    registerAtlassianWebhookRoute(app)
    return app
  }

  it("returns 401 when invocation token is missing", async () => {
    const app = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("returns 401 when invocation token verification fails", async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error("invalid"))
    const app = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer invalid",
        "content-type": "application/json",
      },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("upserts forge installation for known cloud id", async () => {
    const app = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventType: "avi:forge:installed:app",
        payload: {
          cloudId: "cloud_1",
          installation: {
            id: "installation_1",
            installationContext: "ari:cloud:confluence::site/cloud_1",
          },
        },
      }),
    })
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        cloudId: "cloud_1",
        installationId: "installation_1",
        status: "installed",
        appSystemToken: "system_token",
      }),
    )
  })
})
