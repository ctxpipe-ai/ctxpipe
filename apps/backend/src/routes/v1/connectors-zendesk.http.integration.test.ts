import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { members } from "../../db/schema/auth.js"
import {
  connectionDirectory,
  connections,
} from "../../db/schema/connections.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at
// import time.
vi.hoisted(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
})

const ZD = "https://acme.zendesk.com"
const zendesk = { webhookStatus: 201, deleted: [] as string[] }
const server = setupServer(
  http.post(`${ZD}/oauth/tokens`, () =>
    HttpResponse.json({
      access_token: "access-token-fixture",
      refresh_token: "refresh-token-fixture",
      expires_in: 1800,
    }),
  ),
  http.post(`${ZD}/api/v2/webhooks`, () =>
    zendesk.webhookStatus === 201
      ? HttpResponse.json({ webhook: { id: "01WH" } }, { status: 201 })
      : HttpResponse.json({ error: "Forbidden" }, { status: 403 }),
  ),
  http.get(`${ZD}/api/v2/webhooks/01WH/signing_secret`, () =>
    HttpResponse.json({ signing_secret: { secret: "signing-secret-fixture" } }),
  ),
  http.delete(`${ZD}/api/v2/webhooks/:id`, ({ params }) => {
    zendesk.deleted.push(String(params.id))
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${ZD}/api/v2/help_center/categories`, () =>
    HttpResponse.json({
      categories: [{ id: 36, name: "Accounts" }],
      meta: { has_more: false },
    }),
  ),
  http.get(`${ZD}/api/v2/views`, () =>
    HttpResponse.json({
      views: [
        { id: 90, title: "Escalations", active: true },
        { id: 91, title: "Old", active: false },
      ],
      meta: { has_more: false },
    }),
  ),
)

describe("Zendesk connector routes (Postgres + msw)", () => {
  let seed: SeededOrg
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    // Self-host: no deployment OAuth client.
    ZENDESK_CLIENT_ID: undefined,
    ZENDESK_CLIENT_SECRET: undefined,
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use(withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("user", null)
      c.set("session", null)
      c.set("oauthReferenceId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerV1Routes(app)
    return app
  }

  const request = (path: string, init: RequestInit = {}) =>
    createApp().request(`http://backend.test${path}`, {
      ...init,
      headers: {
        cookie: seed.cookie,
        "content-type": "application/json",
        ...init.headers,
      },
    })
  const org = (path: string, init?: RequestInit) =>
    request(`/${seed.orgSlug}/api/v1/connectors/zendesk${path}`, init)

  async function draft() {
    const res = await org("", {
      method: "POST",
      body: JSON.stringify({ subdomain: "acme" }),
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { connectionId: string }).connectionId
  }

  async function saveClient(connectionId: string) {
    const res = await org("/oauth-client", {
      method: "PUT",
      body: JSON.stringify({
        connectionId,
        clientId: "local-client",
        clientSecret: "local-client-secret",
      }),
    })
    expect(res.status).toBe(204)
  }

  /** Start OAuth, then call the callback as the browser would. */
  async function connect(connectionId: string) {
    const start = await org(`/oauth/start?connectionId=${connectionId}`)
    expect(start.status).toBe(200)
    const { authorizationUrl } = (await start.json()) as {
      authorizationUrl: string
    }
    const state = new URL(authorizationUrl).searchParams.get("state") ?? ""
    const pkceCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]
    return request(
      `/api/v1/integrations/zendesk/callback?code=the-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${seed.cookie}; ${pkceCookie}` } },
    )
  }

  async function storedConfig(connectionId: string) {
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select({ config: connections.config })
        .from(connections)
        .where(eq(connections.id, connectionId)),
    )
    return row?.config
  }

  const status = async (connectionId: string) =>
    (await (
      await org(`/status?connectionId=${connectionId}`)
    ).json()) as Record<string, unknown>

  async function setRole(role: string) {
    await getSystemDb()
      .update(members)
      .set({ role })
      .where(
        and(
          eq(members.organizationId, seed.orgId),
          eq(members.userId, seed.userId),
        ),
      )
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    server.listen({ onUnhandledRequest: "bypass" })
    seed = await seedOrg()
  })
  afterEach(() => {
    server.resetHandlers()
    zendesk.webhookStatus = 201
    zendesk.deleted.length = 0
  })
  afterAll(async () => {
    server.close()
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(connections).where(eq(connections.orgId, seed.orgId)),
    )
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, seed.orgId))
    if (seed) await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  it("starts a setup that the list leaves out until it is connected", async () => {
    const connectionId = await draft()
    expect(await draft()).toBe(connectionId)
    const list = (await (
      await request(`/${seed.orgSlug}/api/v1/connectors`)
    ).json()) as {
      items: Array<{ id: string }>
    }
    expect(list.items.map((item) => item.id)).not.toContain(connectionId)
    expect(
      (
        await org("", {
          method: "POST",
          body: JSON.stringify({ subdomain: "acme.evil.example" }),
        })
      ).status,
    ).toBe(400)
  })

  it("needs an OAuth client on a self-hosted deployment before OAuth starts", async () => {
    const connectionId = await draft()
    expect(await status(connectionId)).toMatchObject({
      status: "pending",
      subdomain: "acme",
      oauthClientConfigured: false,
      deploymentOAuthClient: false,
      redirectUri: `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/integrations/zendesk/callback`,
    })
    expect(
      (await org(`/oauth/start?connectionId=${connectionId}`)).status,
    ).toBe(409)
    await saveClient(connectionId)
    expect(await status(connectionId)).toMatchObject({
      oauthClientConfigured: true,
    })
    expect(JSON.stringify(await storedConfig(connectionId))).not.toContain(
      "local-client-secret",
    )
  })

  it("connects through OAuth, saves the tokens encrypted, and creates the webhook", async () => {
    const connectionId = await draft()
    await saveClient(connectionId)

    const callback = await connect(connectionId)

    expect(callback.status).toBe(200)
    const html = await callback.text()
    expect(html).toContain('"type":"zendesk-oauth-complete"')
    expect(html).toContain(connectionId)
    expect(await status(connectionId)).toMatchObject({
      status: "installed",
      webhookConfigured: true,
    })
    const config = JSON.stringify(await storedConfig(connectionId))
    for (const secret of [
      "access-token-fixture",
      "refresh-token-fixture",
      "signing-secret-fixture",
    ])
      expect(config).not.toContain(secret)
    const list = (await (
      await request(`/${seed.orgSlug}/api/v1/connectors`)
    ).json()) as {
      items: Array<{ id: string; displayName: string | null }>
    }
    expect(list.items).toContainEqual(
      expect.objectContaining({ id: connectionId, displayName: "acme" }),
    )
  })

  it("stays connected without a webhook when Zendesk refuses it", async () => {
    const connectionId = await draft()
    await saveClient(connectionId)
    zendesk.webhookStatus = 403

    expect((await connect(connectionId)).status).toBe(200)

    expect(await status(connectionId)).toMatchObject({
      status: "installed",
      webhookConfigured: false,
    })
  })

  it("relays an error to the setup window when Zendesk refuses the code", async () => {
    const connectionId = await draft()
    await saveClient(connectionId)
    server.use(
      http.post(`${ZD}/oauth/tokens`, () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    )

    const callback = await connect(connectionId)

    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('"type":"zendesk-oauth-error"')
    expect(await status(connectionId)).toMatchObject({ status: "pending" })
  })

  it("refuses a callback without the PKCE cookie", async () => {
    const connectionId = await draft()
    await saveClient(connectionId)
    const start = await org(`/oauth/start?connectionId=${connectionId}`)
    const { authorizationUrl } = (await start.json()) as {
      authorizationUrl: string
    }
    const state = new URL(authorizationUrl).searchParams.get("state") ?? ""
    const res = await request(
      `/api/v1/integrations/zendesk/callback?code=c&state=${encodeURIComponent(state)}`,
    )
    expect(res.status).toBe(400)
    // The PKCE cookie is cleared on a refused callback too.
    expect(res.headers.get("set-cookie")).toMatch(/^zendesk_pkce=;.*Max-Age=0/)
  })

  it("lists the categories and the active views for the scope picker", async () => {
    const connectionId = await draft()
    await saveClient(connectionId)
    await connect(connectionId)

    const res = await org(`/catalog?connectionId=${connectionId}`)

    expect(await res.json()).toEqual({
      categories: [{ id: "36", name: "Accounts" }],
      views: [{ id: "90", title: "Escalations" }],
    })
  })

  it("deletes the Zendesk webhook and the connection", async () => {
    const connectionId = await draft()
    await saveClient(connectionId)
    await connect(connectionId)

    const res = await org(`?connectionId=${connectionId}`, { method: "DELETE" })

    expect(res.status).toBe(204)
    expect(zendesk.deleted).toEqual(["01WH"])
    expect(await storedConfig(connectionId)).toBeUndefined()
  })

  it("refuses an org member who is not an admin", async () => {
    await setRole("member")
    try {
      const res = await org("", {
        method: "POST",
        body: JSON.stringify({ subdomain: "acme" }),
      })
      expect(res.status).toBe(403)
    } finally {
      await setRole("owner")
    }
  })
})
