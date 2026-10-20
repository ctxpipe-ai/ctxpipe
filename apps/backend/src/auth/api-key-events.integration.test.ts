import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb, initDb } from "../db/client.js"
import { apikeys, members, organizations } from "../db/schema/auth.js"
import { generateObjectId } from "../lib/id.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { registerAuthRoutes } from "../routes/auth.js"
import { registerV1Routes } from "../routes/v1/index.js"
import { contextStorage } from "../test/hono-test-logger.js"
import { PERSONAL_API_KEY_ORGANIZATIONS_HEADER } from "./personal-api-key-organizations.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

const spans = recordSpans()

type WideEvent = Record<string, unknown>

/**
 * Key lifecycle events (CTX-881). Keys are made, changed and deleted over HTTP
 * through Better Auth, as the browser does it. Each action puts one wide event
 * on its request, with the key id, the actor, the outcome and the org set.
 */
describe("API key lifecycle events (Postgres)", () => {
  const BASE = process.env.AUTH_BASE_URL ?? "http://localhost:3000"
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const events: WideEvent[] = []
  const orgB = { id: generateObjectId("org"), slug: `events-b-${suffix}` }
  let seed: SeededOrg | undefined

  function u(): SeededOrg {
    if (!seed) throw new Error("seed is missing")
    return seed
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    // setup-evlog turns evlog off; this file reads the drained wide events.
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    seed = await seedOrg()
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgB.id,
        name: `Events B ${suffix}`,
        slug: orgB.slug,
        createdAt: new Date(),
      })
    await getSystemDb()
      .insert(members)
      .values({
        id: generateObjectId("member"),
        organizationId: orgB.id,
        userId: u().userId,
        role: "member",
        createdAt: new Date(),
      })
  })

  afterAll(async () => {
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, orgB.id))
    if (seed) {
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  })

  beforeEach(() => {
    events.length = 0
  })

  function createApp() {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use("*", backendOtelMiddleware())
    app.use(
      evlog({
        drain: async (ctx) => {
          for (const item of Array.isArray(ctx) ? ctx : [ctx]) {
            events.push(item.event as WideEvent)
          }
        },
      }),
    )
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
    registerAuthRoutes(app)
    registerV1Routes(app)
    return app
  }

  function authPost(path: string, body: unknown, organizations?: string) {
    return createApp().request(`${BASE}/.auth/api/v1/auth${path}`, {
      method: "POST",
      headers: {
        cookie: u().cookie,
        origin: BASE,
        "content-type": "application/json",
        ...(organizations === undefined
          ? {}
          : { [PERSONAL_API_KEY_ORGANIZATIONS_HEADER]: organizations }),
      },
      body: JSON.stringify(body),
    })
  }

  function eventFor(step: string): WideEvent {
    const found = events.filter(
      (event) => event["ctxpipe.api_key.event"] === step,
    )
    if (found.length !== 1) {
      throw new Error(`expected one ${step} event, got ${found.length}`)
    }
    return found[0] as WideEvent
  }

  async function createKey(organizationIds: string[]) {
    const response = await authPost(
      "/api-key/create",
      { name: `events-${suffix}` },
      organizationIds.join(","),
    )
    expect(response.status).toBe(200)
    return (await response.json()) as { id: string; key: string }
  }

  function noSecretAnywhere(secret: string) {
    const exported = JSON.stringify({
      events,
      spans: spans.finishedSpans().map((span) => span.attributes),
    })
    expect(exported).not.toContain(secret)
  }

  it("emits api_key.create with the key id, the actor, the outcome, read-only and the org set size, and never the key", async () => {
    const created = await createKey([u().orgId, orgB.id])

    const event = eventFor("api_key.create")
    expect(event).toMatchObject({
      "ctxpipe.api_key.outcome": "success",
      "enduser.id": u().userId,
      "api_key.id": created.id,
      "api_key.owner": "personal",
      "api_key.read_only": true,
      "api_key.organization_count": 2,
    })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "enduser.id": u().userId,
      "ctxpipe.actor.type": "user",
      "ctxpipe.api_key.event": "api_key.create",
      "ctxpipe.api_key.outcome": "success",
    })
    noSecretAnywhere(created.key)
    // The key prefix that the API returns to the client is not logged either.
    const [row] = await getSystemDb()
      .select({ start: apikeys.start })
      .from(apikeys)
      .where(eq(apikeys.id, created.id))
    expect(row?.start).toBeTruthy()
    expect(JSON.stringify(events)).not.toContain(row?.start ?? "")
  })

  it("puts the org id on the create and update events of an organization key, and on no personal key event", async () => {
    const created = await authPost("/api-key/create", {
      configId: "organization",
      organizationId: u().orgId,
      name: "events-org",
    })
    expect(created.status).toBe(200)
    const key = (await created.json()) as { id: string; key: string }
    expect(eventFor("api_key.create")).toMatchObject({
      "ctxpipe.org.id": u().orgId,
      "api_key.id": key.id,
      "api_key.owner": "organization",
    })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.org.id": u().orgId,
    })

    events.length = 0
    const updated = await authPost("/api-key/update", {
      keyId: key.id,
      configId: "organization",
      organizationId: u().orgId,
      name: "events-org-renamed",
    })
    expect(updated.status).toBe(200)
    expect(eventFor("api_key.update")).toMatchObject({
      "ctxpipe.org.id": u().orgId,
    })

    // The revoke client sends only the key id and the config id.
    events.length = 0
    const removed = await authPost("/api-key/delete", {
      keyId: key.id,
      configId: "organization",
    })
    expect(removed.status).toBe(200)
    expect(eventFor("api_key.delete")).toMatchObject({
      "ctxpipe.api_key.outcome": "success",
      "ctxpipe.org.id": u().orgId,
      "api_key.id": key.id,
      "api_key.owner": "organization",
    })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.org.id": u().orgId,
    })

    events.length = 0
    const personal = await createKey([u().orgId])
    expect(eventFor("api_key.create")["ctxpipe.org.id"]).toBeUndefined()
    noSecretAnywhere(key.key)
    noSecretAnywhere(personal.key)
  })

  it("emits api_key.create with outcome failure when the org set is refused, and no key id", async () => {
    const response = await authPost(
      "/api-key/create",
      { name: `events-refused-${suffix}` },
      generateObjectId("org"),
    )
    expect(response.status).toBe(400)

    const event = eventFor("api_key.create")
    expect(event).toMatchObject({
      "ctxpipe.api_key.outcome": "failure",
      "enduser.id": u().userId,
    })
    expect(event["api_key.id"]).toBeUndefined()
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.api_key.event": "api_key.create",
      "ctxpipe.api_key.outcome": "failure",
    })
  })

  it("keeps the org id of a refused org key create as a requested id, not as the org of the event", async () => {
    const requested = generateObjectId("org")
    const response = await authPost("/api-key/create", {
      configId: "organization",
      organizationId: requested,
      name: "events-org-refused",
    })
    expect(response.status).toBeGreaterThanOrEqual(400)

    const event = eventFor("api_key.create")
    expect(event).toMatchObject({
      "ctxpipe.api_key.outcome": "failure",
      "api_key.requested_org_id": requested,
    })
    expect(event["ctxpipe.org.id"]).toBeUndefined()
    expect(spans.serverSpan()?.attributes["ctxpipe.org.id"]).toBeUndefined()
  })

  it("emits api_key.update and api_key.delete with the key id and the actor", async () => {
    const created = await createKey([u().orgId])
    events.length = 0

    const update = await authPost("/api-key/update", {
      keyId: created.id,
      name: `renamed-${suffix}`,
    })
    expect(update.status).toBe(200)
    expect(eventFor("api_key.update")).toMatchObject({
      "ctxpipe.api_key.outcome": "success",
      "enduser.id": u().userId,
      "api_key.id": created.id,
    })

    const removed = await authPost("/api-key/delete", { keyId: created.id })
    expect(removed.status).toBe(200)
    expect(eventFor("api_key.delete")).toMatchObject({
      "ctxpipe.api_key.outcome": "success",
      "enduser.id": u().userId,
      "api_key.id": created.id,
    })
    noSecretAnywhere(created.key)
  })

  it("emits api_key.delete with outcome failure for a key that does not exist", async () => {
    const response = await authPost("/api-key/delete", {
      keyId: generateObjectId("key"),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(eventFor("api_key.delete")).toMatchObject({
      "ctxpipe.api_key.outcome": "failure",
    })
  })

  it("emits api_key.organizations.list and api_key.organizations.set on the org set routes", async () => {
    const created = await createKey([u().orgId])
    events.length = 0

    const list = await createApp().request(`${BASE}/api/v1/me/api-keys`, {
      headers: { cookie: u().cookie },
    })
    expect(list.status).toBe(200)
    expect(eventFor("api_key.organizations.list")).toMatchObject({
      "ctxpipe.api_key.outcome": "success",
      "enduser.id": u().userId,
      "api_key.count": expect.any(Number),
    })

    const set = await createApp().request(
      `${BASE}/api/v1/me/api-keys/${created.id}/organizations`,
      {
        method: "PUT",
        headers: { cookie: u().cookie, "content-type": "application/json" },
        body: JSON.stringify({ organizationIds: [u().orgId, orgB.id] }),
      },
    )
    expect(set.status).toBe(204)
    expect(eventFor("api_key.organizations.set")).toMatchObject({
      "ctxpipe.api_key.outcome": "success",
      "enduser.id": u().userId,
      "api_key.id": created.id,
      "api_key.read_only": true,
      "api_key.organization_count": 2,
    })

    events.length = 0
    const refused = await createApp().request(
      `${BASE}/api/v1/me/api-keys/${created.id}/organizations`,
      {
        method: "PUT",
        headers: { cookie: u().cookie, "content-type": "application/json" },
        body: JSON.stringify({ organizationIds: [generateObjectId("org")] }),
      },
    )
    expect(refused.status).toBe(400)
    expect(eventFor("api_key.organizations.set")).toMatchObject({
      "ctxpipe.api_key.outcome": "not_member",
      "api_key.id": created.id,
    })
    noSecretAnywhere(created.key)
  })
})
