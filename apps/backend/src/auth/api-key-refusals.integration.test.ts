import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { apikeys } from "../db/schema/auth.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { contextStorage } from "../test/hono-test-logger.js"
import { getAuth } from "./config.js"
import {
  requireAuth,
  requireOrgAdminOrOwner,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "./withAuth.js"

const spans = recordSpans()

type WideEvent = Record<string, unknown>

/**
 * Key refusals (CTX-881). A refused key must show why, and which key it was
 * when the auth library lets us know. No event holds a key value.
 */
describe("API key refusal events (Postgres)", () => {
  const events: WideEvent[] = []
  let seed: SeededOrg | undefined

  function s(): SeededOrg {
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
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  beforeEach(() => {
    events.length = 0
  })

  function createApp() {
    const app = new Hono<AppEnv>()
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
      c.set("env", parseEnv(process.env as Record<string, string | undefined>))
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
    app.use(
      "/mcp",
      withCookieAuth,
      withOrgApiKeyAuth,
      requireAuth,
      withNetworkOrgContext,
    )
    app.post("/mcp", (c) => c.json({ ok: true }))
    app.use(
      "/mcp/bearer",
      withMcpBearerAuth,
      requireAuth,
      withNetworkOrgContext,
    )
    app.post("/mcp/bearer", (c) => c.json({ ok: true }))
    // No REST route verifies an org key today; this route shows that
    // requireAuth refuses one outside /mcp.
    app.use("/api/v1/org/*", withCookieAuth, withOrgApiKeyAuth)
    app.use("/api/v1/*", withCookieAuth, requireAuth)
    app.use(
      "/api/v1/orgs/:orgSlug/admin",
      withCookieAuth,
      requireAuth,
      withNetworkOrgContext,
      requireOrgAdminOrOwner,
    )
    app.get("/api/v1/orgs/:orgSlug/admin", (c) => c.json({ ok: true }))
    // The user is signed in, but the org is not one that the user belongs to.
    app.use(
      "/api/v1/other-org/admin",
      withCookieAuth,
      requireAuth,
      async (c, next) => {
        c.set("orgId", "org_not_a_member")
        await next()
      },
      requireOrgAdminOrOwner,
    )
    app.get("/api/v1/other-org/admin", (c) => c.json({ ok: true }))
    app.get("/api/v1/org/things", (c) => c.json({ ok: true }))
    app.get("/api/v1/things", (c) => c.json({ ok: true }))
    app.post("/api/v1/things", (c) => c.json({ ok: true }))
    return app
  }

  function mcp(key: string) {
    return createApp().request("http://backend.test/mcp", {
      method: "POST",
      headers: { "x-api-key": key },
    })
  }

  function mcpBearer(key: string) {
    return createApp().request("http://backend.test/mcp/bearer", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    })
  }

  function refusalEvent(): WideEvent {
    const found = events.filter(
      (event) => event["ctxpipe.api_key.event"] === "api_key.refused",
    )
    if (found.length !== 1) {
      throw new Error(`expected one refusal event, got ${found.length}`)
    }
    return found[0] as WideEvent
  }

  function noSecretAnywhere(secret: string) {
    const exported = JSON.stringify({
      events,
      spans: spans.finishedSpans().map((span) => span.attributes),
    })
    expect(exported).not.toContain(secret)
  }

  /** A new personal key whose expiry date is in the past. */
  async function expiredPersonalKey() {
    const created = await getAuth().api.createApiKey({
      body: { name: "refusal-test-personal" },
      headers: new Headers({
        origin: process.env.AUTH_BASE_URL ?? "http://localhost:3000",
        cookie: s().cookie,
      }),
    })
    await getSystemDb()
      .update(apikeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apikeys.id, created.id))
    return created.key
  }

  /** A new org key, so that a test can break it without the shared seed key. */
  async function newOrgKey() {
    const created = await getAuth().api.createApiKey({
      body: {
        configId: "organization",
        name: "refusal-test",
        organizationId: s().orgId,
      },
      headers: new Headers({
        origin: process.env.AUTH_BASE_URL ?? "http://localhost:3000",
        cookie: s().cookie,
      }),
    })
    return { id: created.id, key: created.key }
  }

  it("logs the reason invalid for a key that does not exist, and not the key", async () => {
    const key = "ctx_not_a_real_key_0123456789abcdefghijklmnopqrstuvwxyz"
    const response = await mcp(key)

    expect(response.status).toBe(401)
    const event = refusalEvent()
    expect(event).toMatchObject({
      "ctxpipe.api_key.outcome": "refused",
      "ctxpipe.auth.refusal_reason": "invalid",
    })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.api_key.event": "api_key.refused",
      "ctxpipe.api_key.outcome": "refused",
      "ctxpipe.auth.refusal_reason": "invalid",
    })
    expect(event["ctxpipe.api_key.id"]).toBeUndefined()
    noSecretAnywhere(key)
  })

  it("logs the reason disabled with the id of the key", async () => {
    const created = await newOrgKey()
    await getSystemDb()
      .update(apikeys)
      .set({ enabled: false })
      .where(eq(apikeys.id, created.id))

    const response = await mcp(created.key)

    expect(response.status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "disabled",
      "ctxpipe.api_key.id": created.id,
    })
    noSecretAnywhere(created.key)
  })

  it("logs the reason expired", async () => {
    const created = await newOrgKey()
    await getSystemDb()
      .update(apikeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apikeys.id, created.id))

    const response = await mcp(created.key)

    expect(response.status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "expired",
    })
    noSecretAnywhere(created.key)
  })

  it("logs the reason rate_limited with the id of the key", async () => {
    const created = await newOrgKey()
    await getSystemDb()
      .update(apikeys)
      .set({ requestCount: 1_000_000, lastRequest: new Date() })
      .where(eq(apikeys.id, created.id))

    const response = await mcp(created.key)

    // A 401 would make an OAuth client sign in again; the key must wait.
    expect(response.status).toBe(429)
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "rate_limited",
      "ctxpipe.api_key.id": created.id,
    })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "rate_limited",
    })
    noSecretAnywhere(created.key)
  })

  it("logs the reason expired for an expired personal key on REST", async () => {
    const key = await expiredPersonalKey()
    const response = await createApp().request(
      "http://backend.test/api/v1/things",
      { headers: { "x-api-key": key } },
    )

    expect(response.status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.api_key.outcome": "refused",
      "ctxpipe.auth.refusal_reason": "expired",
    })
    noSecretAnywhere(key)
  })

  it("logs the reason expired for an expired personal key on /mcp", async () => {
    const key = await expiredPersonalKey()

    expect((await mcp(key)).status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "expired",
    })
    noSecretAnywhere(key)
  })

  it("logs the reason mcp_only with the key id for an org key outside /mcp", async () => {
    const response = await createApp().request(
      "http://backend.test/api/v1/org/things",
      { headers: { "x-api-key": s().orgApiKey } },
    )

    expect(response.status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      level: "warn",
      "ctxpipe.auth.refusal_reason": "mcp_only",
      "ctxpipe.api_key.id": expect.any(String),
    })
    noSecretAnywhere(s().orgApiKey)
  })

  it("logs no key refusal for an opaque Bearer token that is no key, such as an expired OAuth token", async () => {
    const token = "oauthAccessTokenThatHasExpired0123"
    expect((await mcpBearer(token)).status).toBe(401)
    expect(
      events.filter((e) => e["ctxpipe.api_key.event"] === "api_key.refused"),
    ).toEqual([])
    expect(
      spans.serverSpan()?.attributes["ctxpipe.api_key.event"],
    ).toBeUndefined()
    noSecretAnywhere(token)
  })

  it("logs the reason for a refused Bearer key, with the key id when known, and not the key", async () => {
    const personal = await expiredPersonalKey()
    expect((await mcpBearer(personal)).status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.api_key.outcome": "refused",
      "ctxpipe.auth.refusal_reason": "expired",
    })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.api_key.event": "api_key.refused",
      "ctxpipe.auth.refusal_reason": "expired",
    })
    noSecretAnywhere(personal)

    const disabled = await newOrgKey()
    await getSystemDb()
      .update(apikeys)
      .set({ enabled: false })
      .where(eq(apikeys.id, disabled.id))
    events.length = 0
    const disabledResponse = await mcpBearer(disabled.key)
    expect(disabledResponse.status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "disabled",
      "ctxpipe.api_key.id": disabled.id,
    })
    // The caller reads the same text as for an unknown token, so the 401
    // does not say that the key exists.
    const unknownResponse = await mcpBearer(
      "ctx_not_a_real_key_0123456789abcdefghijklmnopqrstuvwxyz",
    )
    expect(disabledResponse.headers.get("www-authenticate")).toBe(
      unknownResponse.headers.get("www-authenticate"),
    )
    expect(disabledResponse.headers.get("www-authenticate")).toContain(
      "The access token could not be validated",
    )
    noSecretAnywhere(disabled.key)

    const expired = await newOrgKey()
    await getSystemDb()
      .update(apikeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apikeys.id, expired.id))
    events.length = 0
    expect((await mcpBearer(expired.key)).status).toBe(401)
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "expired",
    })
    noSecretAnywhere(expired.key)

    const limited = await newOrgKey()
    await getSystemDb()
      .update(apikeys)
      .set({ requestCount: 1_000_000, lastRequest: new Date() })
      .where(eq(apikeys.id, limited.id))
    events.length = 0
    const limitedResponse = await mcpBearer(limited.key)
    expect(limitedResponse.status).toBe(429)
    expect(Number(limitedResponse.headers.get("retry-after"))).toBeGreaterThan(
      0,
    )
    expect(refusalEvent()).toMatchObject({
      "ctxpipe.auth.refusal_reason": "rate_limited",
      "ctxpipe.api_key.id": limited.id,
    })
    noSecretAnywhere(limited.key)
  })

  it("gives the reason token_not_recognized for an unknown Bearer token that is not a key, and not the token", async () => {
    const token = "unknown-opaque-token-0123456789abcdefghijklmnop"
    const response = await createApp().request(
      "http://backend.test/mcp/bearer",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    )

    expect(response.status).toBe(401)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "token_not_recognized",
    })
    noSecretAnywhere(token)
  })

  it("gives the reason token_signature_invalid for a JWT that no key signed", async () => {
    const token = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.c2ln`
    const response = await createApp().request(
      "http://backend.test/api/v1/things",
      { headers: { authorization: `Bearer ${token}` } },
    )

    // This route has no Bearer middleware, so the request has no session.
    expect(response.status).toBe(401)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "no_session",
    })
    const bearer = await createApp().request("http://backend.test/mcp/bearer", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bearer.status).toBe(401)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "token_signature_invalid",
    })
  })

  it("gives the reason no_session for a request with no credential", async () => {
    const response = await createApp().request(
      "http://backend.test/api/v1/things",
    )

    expect(response.status).toBe(401)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "no_session",
    })
  })

  it("logs a warning with the reason org_not_found when the org of the request is not found", async () => {
    const response = await createApp().request(
      "http://backend.test/mcp?orgSlug=no-such-org-slug",
      { method: "POST", headers: { cookie: s().cookie } },
    )

    expect(response.status).toBe(404)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "org_not_found",
    })
    expect(events.at(-1)).toMatchObject({
      level: "warn",
      reason: "org_not_found",
      requestLogs: [
        expect.objectContaining({
          message: "The organization of the request was not found",
        }),
      ],
    })
    expect(JSON.stringify(events)).not.toContain("no-such-org-slug")
  })

  it("gives a reason for each 403 of the org admin check", async () => {
    const allowed = await createApp().request(
      `http://backend.test/api/v1/orgs/${s().orgSlug}/admin`,
      { headers: { cookie: s().cookie } },
    )
    expect(allowed.status).toBe(200)

    const notAdmin = await createApp().request(
      "http://backend.test/api/v1/other-org/admin",
      { headers: { cookie: s().cookie } },
    )
    expect(notAdmin.status).toBe(403)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "not_org_admin",
    })

    const withKey = await createApp().request(
      `http://backend.test/api/v1/orgs/${s().orgSlug}/admin`,
      { headers: { "x-api-key": s().personalApiKey } },
    )
    expect(withKey.status).toBe(403)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.auth.refusal_reason": "api_key_not_allowed",
    })
  })

  it("logs no refusal for a valid Bearer key", async () => {
    expect((await mcpBearer(s().orgApiKey)).status).toBe(200)
    expect(
      events.filter((e) => e["ctxpipe.api_key.event"] === "api_key.refused"),
    ).toEqual([])
  })

  it("logs no refusal for a valid key", async () => {
    expect((await mcp(s().orgApiKey)).status).toBe(200)
    expect(
      events.filter(
        (event) => event["ctxpipe.api_key.event"] === "api_key.refused",
      ),
    ).toEqual([])
  })

  it("logs a warning with the key id when a personal key writes", async () => {
    const response = await createApp().request(
      "http://backend.test/api/v1/things",
      { method: "POST", headers: { "x-api-key": s().personalApiKey } },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: "write_grant_required",
    })
    const event = events.find(
      (item) => item["ctxpipe.api_key.event"] === "api_key.read_only",
    )
    expect(event).toMatchObject({
      level: "warn",
      "ctxpipe.api_key.outcome": "refused",
      "ctxpipe.auth.refusal_reason": "read_only",
      "ctxpipe.api_key.id": expect.any(String),
    })
    expect(event?.route).toBeUndefined()
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.api_key.event": "api_key.read_only",
      "ctxpipe.auth.refusal_reason": "read_only",
    })
    noSecretAnywhere(s().personalApiKey)
  })

  it("logs no read-only refusal when a personal key reads", async () => {
    const response = await createApp().request(
      "http://backend.test/api/v1/things",
      { headers: { "x-api-key": s().personalApiKey } },
    )

    expect(response.status).toBe(200)
    expect(
      events.filter(
        (event) => event["ctxpipe.api_key.event"] === "api_key.read_only",
      ),
    ).toEqual([])
  })
})
