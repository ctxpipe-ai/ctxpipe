import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SpanKind } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import {
  apikeys,
  members,
  oauthAccessTokens,
  oauthClients,
  organizations,
  sessions,
  users,
} from "../db/schema/auth.js"
import { generateObjectId } from "../lib/id.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { resetBetterAuthForTests } from "./config.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "./withAuth.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const email = `auth-http-${suffix}@example.com`
const password = "integration-password-1"
const orgSlug = `auth-http-${suffix}`

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

function serverSpan() {
  return exporter
    .getFinishedSpans()
    .find((span) => span.kind === SpanKind.SERVER)
}

function cookieHeader(response: Response): string {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : []
  const pairs = (
    setCookies.length > 0
      ? setCookies
      : [response.headers.get("set-cookie") ?? ""]
  )
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter((cookie) => cookie.includes("="))
  if (pairs.length === 0) {
    throw new Error("sign-up did not set a session cookie")
  }
  return pairs.join("; ")
}

describe.skipIf(!connectionString)("auth attribution (Postgres)", () => {
  let cookie = ""
  let userId = ""
  let orgId = ""
  let personalKey = ""
  let orgKey = ""
  let opaqueToken = ""

  beforeAll(async () => {
    if (!connectionString) return
    provider.register()
    process.env.AUTH_SECRET =
      process.env.AUTH_SECRET ?? "abcdefghijklmnopqrstuvwxyz123456"
    process.env.AUTH_BASE_URL =
      process.env.AUTH_BASE_URL ?? "http://localhost:3000"
    resetBetterAuthForTests()
    initDb(connectionString)
    const { getAuth } = await import("./config.js")
    const auth = getAuth()
    const signedUp = await auth.api.signUpEmail({
      body: { email, password, name: "Ada Attribution" },
      asResponse: true,
    })
    expect(signedUp.status).toBe(200)
    cookie = cookieHeader(signedUp)
    const body = (await signedUp.json()) as { user: { id: string } }
    userId = body.user.id

    const db = getSystemDb()
    orgId = generateObjectId("org")
    await db.insert(organizations).values({
      id: orgId,
      name: "Auth HTTP",
      slug: orgSlug,
      createdAt: new Date(),
    })
    await db.insert(members).values({
      id: generateObjectId("mbr"),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    })

    const personal = await auth.api.createApiKey({
      body: { configId: "default", userId, name: "personal" },
    })
    personalKey = personal.key
    const org = await auth.api.createApiKey({
      body: {
        configId: "organization",
        organizationId: orgId,
        userId,
        name: "org",
      },
    })
    orgKey = org.key

    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .limit(1)
    if (!session) throw new Error("sign-up did not store a session")
    const clientId = `client_${suffix}`
    opaqueToken = `opaque_${suffix}`
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
  })

  beforeEach(() => {
    exporter.reset()
  })

  afterAll(async () => {
    if (!connectionString) return
    const db = getSystemDb()
    await db.delete(apikeys).where(eq(apikeys.referenceId, userId))
    await db.delete(apikeys).where(eq(apikeys.referenceId, orgId))
    await db.delete(organizations).where(eq(organizations.id, orgId))
    await db.delete(users).where(eq(users.id, userId))
    resetBetterAuthForTests()
    await closeDb()
    await provider.shutdown()
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
    expect(serverSpan()?.attributes).toMatchObject({
      "ctxpipe.actor.type": "user",
      "enduser.id": userId,
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
    })
    expect(serverSpan()?.attributes["ctxpipe.api_key.id"]).toBeUndefined()
  })

  it("attributes a personal api key without logging the secret", async () => {
    const app = createApp()
    const response = await app.request(
      `http://backend.test/mcp?orgSlug=${orgSlug}`,
      { method: "POST", headers: { "x-api-key": personalKey } },
    )
    expect(response.status).toBe(200)
    const attributes = serverSpan()?.attributes
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
    const attributes = serverSpan()?.attributes
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
    expect(serverSpan()?.attributes).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "enduser.id": userId,
      "ctxpipe.oauth.client_id": `client_${suffix}`,
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
    })
    expect(JSON.stringify(serverSpan()?.attributes)).not.toContain(opaqueToken)
  })
})
