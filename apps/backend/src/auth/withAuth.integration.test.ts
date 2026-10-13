import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import {
  oauthAccessTokens,
  oauthClients,
  organizations,
  sessions,
} from "../db/schema/auth.js"
import { generateObjectId } from "../lib/id.js"
import { backendOtelMiddleware } from "../observability/http.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "./withAuth.js"

const spans = recordSpans()

describeWithDatabase("auth attribution (Postgres)", () => {
  let seeded: SeededOrg | undefined
  let cookie = ""
  let userId = ""
  let orgId = ""
  let orgSlug = ""
  let personalKey = ""
  let orgKey = ""
  let opaqueToken = ""
  let clientId = ""
  let otherOrgId = ""
  let otherOrgSlug = ""

  beforeAll(async () => {
    const seed = await seedOrg()
    seeded = seed
    cookie = seed.cookie
    userId = seed.userId
    orgId = seed.orgId
    orgSlug = seed.orgSlug
    personalKey = seed.personalApiKey
    orgKey = seed.orgApiKey

    const db = getSystemDb()
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .limit(1)
    if (!session) throw new Error("sign-up did not store a session")
    clientId = `client_${userId}`
    opaqueToken = `opaque_${userId}`
    await db.insert(oauthClients).values({
      id: generateObjectId("oac"),
      clientId,
      redirectUris: ["http://localhost/callback"],
      createdAt: new Date(),
      updatedAt: new Date(),
      userId,
    })
    await db.insert(oauthAccessTokens).values({
      id: generateObjectId("oat"),
      token: createHash("sha256").update(opaqueToken).digest("base64url"),
      clientId,
      sessionId: session.id,
      userId,
      referenceId: orgId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      scopes: ["openid"],
    })
    // An organization the seeded user does not belong to.
    otherOrgId = generateObjectId("org")
    otherOrgSlug = `other-${userId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`
    await db.insert(organizations).values({
      id: otherOrgId,
      name: "Other org",
      slug: otherOrgSlug,
      createdAt: new Date(),
    })
  })

  afterAll(async () => {
    if (otherOrgId) {
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, otherOrgId))
    }
    if (seeded) await cleanupSeededOrg(seeded)
  })

  function createApp() {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use("*", backendOtelMiddleware())
    app.use(evlog())
    app.use("*", async (c, next) => {
      c.set("env", parseEnv(process.env as Record<string, string | undefined>))
      c.set("user", null)
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    app.use(
      "/mcp",
      withMcpBearerAuth,
      withCookieAuth,
      withOrgApiKeyAuth,
      requireAuth,
      withNetworkOrgContext,
    )
    app.post("/mcp", (c) => c.json({ userId: c.get("user")?.id ?? null }))
    app.use(
      "/:orgSlug/api/v1/*",
      withBearerAuth,
      withCookieAuth,
      requireAuth,
      withNetworkOrgContext,
    )
    app.get("/:orgSlug/api/v1/whoami", (c) =>
      c.json({ userId: c.get("user")?.id ?? null, orgId: c.get("orgId") }),
    )
    return app
  }

  it("attributes a cookie session on the server span", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/${orgSlug}/api/v1/whoami`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId, orgId })
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.actor.type": "user",
      "enduser.id": userId,
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
    })
    expect(spans.serverSpan()?.attributes["ctxpipe.api_key.id"]).toBeUndefined()
  })

  it("attributes a personal api key without logging the secret", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/mcp?orgSlug=${orgSlug}`,
      { method: "POST", headers: { "x-api-key": personalKey } },
    )
    expect(response.status).toBe(200)
    const attributes = spans.serverSpan()?.attributes
    expect(attributes).toMatchObject({
      "ctxpipe.actor.type": "user",
      "enduser.id": userId,
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
    })
    expect(attributes?.["ctxpipe.api_key.id"]).toEqual(expect.any(String))
    expect(JSON.stringify(attributes)).not.toContain(personalKey)
  })

  it("attributes an org api key without an end user", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/mcp?orgSlug=${orgSlug}`,
      { method: "POST", headers: { "x-api-key": orgKey } },
    )
    expect(response.status).toBe(200)
    const attributes = spans.serverSpan()?.attributes
    expect(attributes).toMatchObject({
      "ctxpipe.actor.type": "org_api_key",
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
    })
    expect(attributes?.["enduser.id"]).toBeUndefined()
    expect(attributes?.["ctxpipe.api_key.id"]).toEqual(expect.any(String))
    expect(JSON.stringify(attributes)).not.toContain(orgKey)
  })

  it("attributes an opaque oauth client", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/mcp?orgSlug=${orgSlug}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${opaqueToken}` },
      },
    )
    expect(response.status).toBe(200)
    expect(spans.serverSpan()?.attributes).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "enduser.id": userId,
      "ctxpipe.oauth.client_id": clientId,
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
    })
    expect(JSON.stringify(spans.serverSpan()?.attributes)).not.toContain(
      opaqueToken,
    )
  })

  it("tells an MCP client its OAuth grant is for a different organization than orgSlug", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/mcp?orgSlug=${otherOrgSlug}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${opaqueToken}` },
      },
    )
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600 },
      id: null,
    })
    expect(body.error.message).toContain(otherOrgSlug)
    expect(body.error.message).toContain("different organization")
    expect(body.error.message).toContain("Reconnect")
  })

  it("gives an MCP client one answer for an org it cannot access, whether or not the org exists", async () => {
    const app = createApp()
    const notMember = await app.request(
      `http://backend.test/mcp?orgSlug=${otherOrgSlug}`,
      { method: "POST", headers: { cookie } },
    )
    const missingSlug = `missing-${userId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`
    const missing = await app.request(
      `http://backend.test/mcp?orgSlug=${missingSlug}`,
      { method: "POST", headers: { cookie } },
    )

    expect(notMember.status).toBe(400)
    expect(missing.status).toBe(400)
    const notMemberBody = await notMember.json()
    const missingBody = await missing.json()
    expect(notMemberBody).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600 },
      id: null,
    })
    expect(notMemberBody.error.message).toContain(otherOrgSlug)
    expect(missingBody.error.message).toBe(
      notMemberBody.error.message.replace(otherOrgSlug, missingSlug),
    )
  })

  it("keeps a bare 404 for an inaccessible org outside /mcp", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/${otherOrgSlug}/api/v1/whoami`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
  })
})
