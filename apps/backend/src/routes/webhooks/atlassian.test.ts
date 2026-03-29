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

const getForgeInstallationByCloudIdMock = vi.hoisted(() => vi.fn())
const getPendingForgeInstallationByInstallerAccountIdMock = vi.hoisted(() =>
  vi.fn(),
)
const upsertForgeInstallationFromEventMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/atlassian-connector.js", () => ({
  getForgeInstallationByCloudId: getForgeInstallationByCloudIdMock,
  getPendingForgeInstallationByInstallerAccountId:
    getPendingForgeInstallationByInstallerAccountIdMock,
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
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "forge-event",
        app: {
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
        },
      },
    })
    getForgeInstallationByCloudIdMock.mockResolvedValue({
      orgId: "org_1",
      cloudId: "cloud_1",
      installedByUserId: "user_1",
    })
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValue(
      undefined,
    )
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
        id: "installation_1",
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_1",
        installerAccountId: "atl_installer_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })
    expect(res.status).toBe(204)
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        cloudId: "cloud_1",
        installationId: "installation_1",
        appId: "forge_app_1",
        status: "installed",
        appSystemToken: "system_token",
        atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_1",
      }),
    )
  })

  it("does not persist invalid FIT apiBaseUrl", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "forge-event",
        app: {
          apiBaseUrl: "http://api.atlassian.com/ex/confluence/cloud_1",
        },
      },
    })
    const app = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "installation_1",
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_1",
        installerAccountId: "atl_installer_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })
    expect(res.status).toBe(204)
    const arg = upsertForgeInstallationFromEventMock.mock
      .calls[0]?.[0] as Record<string, unknown>
    expect(arg.atlassianApiBaseUrl).toBeUndefined()
  })

  it("falls back to pending installation matched by installer account id", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "forge-event",
        app: {
          apiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud_pending",
        },
      },
    })
    getForgeInstallationByCloudIdMock.mockResolvedValueOnce(undefined)
    getPendingForgeInstallationByInstallerAccountIdMock.mockResolvedValueOnce({
      id: "fgi_pending_1",
      orgId: "org_pending",
      installedByUserId: "user_pending",
    })

    const app = createApp()
    const res = await app.request("/api/v1/webhook/atlassian/forge", {
      method: "POST",
      headers: {
        authorization: "Bearer fit_token",
        "x-forge-oauth-system": "system_token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "installation_pending",
        eventType: "avi:forge:installed:app",
        context: "ari:cloud:confluence::site/cloud_pending",
        installerAccountId: "atl_account_1",
        app: {
          id: "forge_app_1",
          version: "1.0.0",
        },
        environment: { id: "env_1" },
      }),
    })

    expect(res.status).toBe(204)
    expect(
      getPendingForgeInstallationByInstallerAccountIdMock,
    ).toHaveBeenCalledWith("atl_account_1")
    expect(upsertForgeInstallationFromEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_pending",
        cloudId: "cloud_pending",
        installationId: "installation_pending",
        appId: "forge_app_1",
        atlassianApiBaseUrl:
          "https://api.atlassian.com/ex/confluence/cloud_pending",
      }),
    )
  })
})
