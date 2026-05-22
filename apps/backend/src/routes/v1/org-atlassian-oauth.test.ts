import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { CONNECTION_TYPE_FORGE } from "../../db/schema/connections.js"

const getActiveMemberRoleMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getActiveMemberRole: getActiveMemberRoleMock },
  }),
}))

const limitResult = vi.hoisted<{ value: unknown[] }>(() => ({ value: [] }))

vi.mock("../../db/client.js", () => ({
  getSystemDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(limitResult.value)),
        })),
      })),
    })),
  })),
}))

const patchForgeConnectionTypedConfigMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/atlassian-connector.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/atlassian-connector.js")>()
  return {
    ...actual,
    patchForgeConnectionTypedConfig: patchForgeConnectionTypedConfigMock,
  }
})

vi.mock("../../config/env.js", () => ({
  parseEnv: (_e: Record<string, string | undefined>) => ({
    AUTH_BASE_URL: "https://app.test",
    AUTH_SECRET: "a".repeat(32),
    ATLASSIAN_CLIENT_ID: "",
    ATLASSIAN_CLIENT_SECRET: "",
  }),
}))

import {
  orgAtlassianOauthAdminRoutes,
  orgAtlassianOauthReadRoutes,
} from "./org-atlassian-oauth.js"

function forgeRow(config: Record<string, unknown>) {
  return {
    id: "conn_forge_1",
    orgId: "org_1",
    type: CONNECTION_TYPE_FORGE,
    config,
  }
}

function mountApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    c.set("orgSlug", "acme")
    await next()
  })
  app.route("/org/atlassian-oauth", orgAtlassianOauthReadRoutes)
  app.route("/org/atlassian-oauth", orgAtlassianOauthAdminRoutes)
  return app
}

describe("GET /org/atlassian-oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    limitResult.value = []
  })

  it("returns metadata without any secret fields", async () => {
    limitResult.value = [
      forgeRow({
        atlassianOAuthClientId: "client-id-one",
        atlassianOAuthClientSecret: "super-secret-value",
      }),
    ]

    const app = mountApp()
    const res = await app.request(
      "/org/atlassian-oauth?connectionId=conn_forge_1",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.oauthAppSaved).toBe(true)
    expect(body.atlassianOAuthClientId).toBe("client-id-one")
    expect(body.globalAtlassianOAuthConfigured).toBe(false)
    expect(body.oauthCallbackUrl).toContain(
      "/api/v1/integrations/atlassian/callback",
    )
    expect(body.atlassianCreateUrl).toContain("developer.atlassian.com")
    expect("atlassianOAuthClientSecret" in body).toBe(false)
    const keys = Object.keys(body).sort()
    expect(keys).toEqual([
      "atlassianCreateUrl",
      "atlassianOAuthClientId",
      "globalAtlassianOAuthConfigured",
      "oauthAppSaved",
      "oauthCallbackUrl",
    ])
  })

  it("returns 404 when connection is missing", async () => {
    limitResult.value = []
    const app = mountApp()
    const res = await app.request("/org/atlassian-oauth?connectionId=missing")
    expect(res.status).toBe(404)
  })

  it("returns 404 when org is not resolved", async () => {
    limitResult.value = [
      forgeRow({
        atlassianOAuthClientId: "cid",
        atlassianOAuthClientSecret: "sec",
      }),
    ]
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
      await next()
    })
    app.route("/org/atlassian-oauth", orgAtlassianOauthReadRoutes)
    const res = await app.request(
      "/org/atlassian-oauth?connectionId=conn_forge_1",
    )
    expect(res.status).toBe(404)
  })
})

describe("PUT /org/atlassian-oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveMemberRoleMock.mockResolvedValue({ role: "admin" })
    limitResult.value = []
    patchForgeConnectionTypedConfigMock.mockResolvedValue({ ok: true })
  })

  it("returns 400 when first save omits clientSecret", async () => {
    limitResult.value = [
      forgeRow({
        status: "active",
      }),
    ]

    const app = mountApp()
    const res = await app.request(
      "/org/atlassian-oauth?connectionId=conn_forge_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "new-id" }),
      },
    )
    expect(res.status).toBe(400)
    expect(patchForgeConnectionTypedConfigMock).not.toHaveBeenCalled()
  })

  it("returns 204 on first save with clientSecret", async () => {
    limitResult.value = [forgeRow({ status: "active" })]

    const app = mountApp()
    const res = await app.request(
      "/org/atlassian-oauth?connectionId=conn_forge_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "cid1", clientSecret: "sec1" }),
      },
    )
    expect(res.status).toBe(204)
    expect(patchForgeConnectionTypedConfigMock).toHaveBeenCalledWith(
      "org_1",
      "conn_forge_1",
      expect.objectContaining({
        atlassianOAuthClientId: "cid1",
        atlassianOAuthClientSecret: "sec1",
      }),
    )
  })

  it("returns 204 and omits secret from patch when rotating is skipped", async () => {
    limitResult.value = [
      forgeRow({
        atlassianOAuthClientId: "old-cid",
        atlassianOAuthClientSecret: "old-secret",
      }),
    ]

    const app = mountApp()
    const res = await app.request(
      "/org/atlassian-oauth?connectionId=conn_forge_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "updated-cid" }),
      },
    )
    expect(res.status).toBe(204)
    expect(patchForgeConnectionTypedConfigMock).toHaveBeenCalledWith(
      "org_1",
      "conn_forge_1",
      expect.objectContaining({
        atlassianOAuthClientId: "updated-cid",
      }),
    )
    const patch = patchForgeConnectionTypedConfigMock.mock
      .calls[0][2] as Record<string, unknown>
    expect("atlassianOAuthClientSecret" in patch).toBe(false)
  })

  it("returns 403 when user is not org admin or owner", async () => {
    getActiveMemberRoleMock.mockResolvedValueOnce({ role: "member" })
    limitResult.value = [forgeRow({ status: "active" })]

    const app = mountApp()
    const res = await app.request(
      "/org/atlassian-oauth?connectionId=conn_forge_1",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "cid1", clientSecret: "sec1" }),
      },
    )
    expect(res.status).toBe(403)
  })
})
