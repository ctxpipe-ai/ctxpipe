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

const API = "https://api.buildkite.com/v2"
const GOOD_TOKEN = "bkua_good_token_fixture"
const server = setupServer(
  http.get(`${API}/access-token`, ({ request }) =>
    request.headers.get("authorization") === `Bearer ${GOOD_TOKEN}`
      ? HttpResponse.json({ scopes: ["read_pipelines", "read_builds"] })
      : HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
  ),
  http.get(`${API}/organizations/:slug/pipelines`, ({ params }) =>
    params.slug === "acme"
      ? HttpResponse.json([
          { slug: "web-app", name: "Web App" },
          { slug: "deploy", name: "Deploy" },
        ])
      : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
)

describe("Buildkite connector routes (Postgres + msw)", () => {
  let seed: SeededOrg
  const env = parseEnv(process.env as Record<string, string | undefined>)

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
    createApp().request(
      `http://backend.test/${seed.orgSlug}/api/v1/connectors${path}`,
      {
        ...init,
        headers: {
          cookie: seed.cookie,
          "content-type": "application/json",
          ...init.headers,
        },
      },
    )

  const connect = (body: Record<string, unknown>) =>
    request("/buildkite", { method: "POST", body: JSON.stringify(body) })

  async function storedConfig(connectionId: string) {
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select({ config: connections.config })
        .from(connections)
        .where(eq(connections.id, connectionId)),
    )
    return row?.config
  }

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
  afterEach(() => server.resetHandlers())
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

  it("connects with a checked token, stores it encrypted, and lists the connection", async () => {
    const res = await connect({
      organizationSlug: "acme",
      apiToken: GOOD_TOKEN,
    })

    expect(res.status).toBe(200)
    const { connectionId } = (await res.json()) as { connectionId: string }
    expect(JSON.stringify(await storedConfig(connectionId))).not.toContain(
      GOOD_TOKEN,
    )
    const list = (await (await request("")).json()) as {
      items: Array<{ id: string; type: string; displayName: string | null }>
    }
    expect(list.items).toContainEqual(
      expect.objectContaining({
        id: connectionId,
        type: "buildkite",
        displayName: "acme",
      }),
    )
    const [directory] = await getSystemDb()
      .select()
      .from(connectionDirectory)
      .where(eq(connectionDirectory.connectionId, connectionId))
    expect(directory?.type).toBe("buildkite")
  })

  it("gives the reason of Buildkite for a bad token, and saves nothing", async () => {
    const before = await withOrgDbContext(seed.orgId, (db) =>
      db.select().from(connections).where(eq(connections.orgId, seed.orgId)),
    )

    const res = await connect({ organizationSlug: "acme", apiToken: "bad" })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Buildkite does not accept this API access token.",
    })
    const after = await withOrgDbContext(seed.orgId, (db) =>
      db.select().from(connections).where(eq(connections.orgId, seed.orgId)),
    )
    expect(after).toHaveLength(before.length)
  })

  it("refuses an organization slug that is not a slug, and calls no Buildkite API", async () => {
    const calls: string[] = []
    server.use(
      http.all("https://api.buildkite.com/*", ({ request }) => {
        calls.push(request.url)
        return new HttpResponse(null, { status: 500 })
      }),
    )

    const res = await connect({
      organizationSlug: "acme/pipelines/x?y=",
      apiToken: GOOD_TOKEN,
    })

    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })

  it("shows the status and webhook URL, and saves the webhook token", async () => {
    const { connectionId } = (await (
      await connect({ organizationSlug: "acme", apiToken: GOOD_TOKEN })
    ).json()) as { connectionId: string }
    const status = async () =>
      (await (
        await request(`/buildkite/status?connectionId=${connectionId}`)
      ).json()) as Record<string, unknown>

    expect(await status()).toEqual({
      status: "installed",
      organizationSlug: "acme",
      webhookUrl: `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/buildkite/${connectionId}`,
      webhookConfigured: false,
    })

    const saved = await request("/buildkite/webhook-token", {
      method: "PUT",
      body: JSON.stringify({ connectionId, webhookToken: "hook-token" }),
    })
    expect(saved.status).toBe(204)
    expect(await status()).toMatchObject({ webhookConfigured: true })
    expect(JSON.stringify(await storedConfig(connectionId))).not.toContain(
      "hook-token",
    )
  })

  it("lists the pipelines of the organization for the scope picker", async () => {
    const { connectionId } = (await (
      await connect({ organizationSlug: "acme", apiToken: GOOD_TOKEN })
    ).json()) as { connectionId: string }

    const res = await request(
      `/buildkite/pipelines?connectionId=${connectionId}`,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      items: [
        { slug: "web-app", name: "Web App" },
        { slug: "deploy", name: "Deploy" },
      ],
      truncated: false,
    })
  })

  it("replaces the token on a reconnect, but not for another organization", async () => {
    const { connectionId } = (await (
      await connect({ organizationSlug: "acme", apiToken: GOOD_TOKEN })
    ).json()) as { connectionId: string }
    server.use(
      http.get(`${API}/organizations/other/pipelines`, () =>
        HttpResponse.json([]),
      ),
    )

    expect(
      (
        await connect({
          connectionId,
          organizationSlug: "acme",
          apiToken: GOOD_TOKEN,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await connect({
          connectionId,
          organizationSlug: "other",
          apiToken: GOOD_TOKEN,
        })
      ).status,
    ).toBe(409)
  })

  it("removes the connection and its directory row", async () => {
    const { connectionId } = (await (
      await connect({ organizationSlug: "acme", apiToken: GOOD_TOKEN })
    ).json()) as { connectionId: string }

    const res = await request(`/buildkite?connectionId=${connectionId}`, {
      method: "DELETE",
    })

    expect(res.status).toBe(204)
    expect(await storedConfig(connectionId)).toBeUndefined()
    expect(
      await getSystemDb()
        .select()
        .from(connectionDirectory)
        .where(eq(connectionDirectory.connectionId, connectionId)),
    ).toEqual([])
  })

  it("refuses an org member who is not an admin", async () => {
    await setRole("member")
    try {
      const res = await connect({
        organizationSlug: "acme",
        apiToken: GOOD_TOKEN,
      })
      expect(res.status).toBe(403)
    } finally {
      await setRole("owner")
    }
  })
})
