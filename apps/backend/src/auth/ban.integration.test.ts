import { createHash, randomBytes, randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import {
  apikeys,
  deviceCodes,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  sessions,
  users,
} from "../db/schema/auth.js"
import { generateObjectId } from "../lib/id.js"
import { adminBanUser } from "../openworkflow/workflows/admin.js"
import { registerAuthRoutes } from "../routes/auth.js"
import { withTestRequestLogger } from "../test/hono-test-logger.js"
import { DEVICE_LOGIN_CLIENT_ID, getAuth } from "./config.js"
import {
  requireAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withOrgApiKeyAuth,
} from "./withAuth.js"

const REDIRECT_URI = "http://127.0.0.1:4567/callback"
const PASSWORD = "integration-seed-password"

/** The `/mcp` auth chain of the app, with every credential kind, and Better Auth. */
function createApp() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("user", null)
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("oauthScopes", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  registerAuthRoutes(app)
  app.post(
    "/mcp",
    withMcpBearerAuth,
    withCookieAuth,
    withOrgApiKeyAuth,
    requireAuth,
    (c) =>
      c.json({
        userId: c.get("user")?.id ?? null,
        orgKey: Boolean(c.get("orgApiKey")),
      }),
  )
  return { app, baseUrl: env.AUTH_BASE_URL.replace(/\/$/, "") }
}

describe("a ban (Postgres)", () => {
  let seed: SeededOrg
  let app: Hono<AppEnv>
  let baseUrl = ""
  /** Each credential kind of the user, as request headers. */
  const credentials: Record<string, Record<string, string>> = {}
  let refreshToken = ""
  let oauthClientId = ""
  let deviceCode = ""

  const call = (headers: Record<string, string>) =>
    app.request(`${baseUrl}/mcp`, { method: "POST", headers })

  const setBan = (banned: boolean, banExpires: Date | null = null) =>
    getSystemDb()
      .update(users)
      .set({ banned, banExpires })
      .where(eq(users.id, seed.userId))

  async function registerClient(): Promise<string> {
    const register = await app.request(
      `${baseUrl}/.auth/api/v1/auth/oauth2/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({
          client_name: "Ban test host",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      },
    )
    expect(register.status).toBe(201)
    return ((await register.json()) as { client_id: string }).client_id
  }

  /** A real authorization code flow: a JWT access token and a refresh token. */
  async function oauthTokens(clientId: string) {
    const verifier = randomBytes(32).toString("base64url")
    const authorizeUrl = new URL(
      `${baseUrl}/.auth/api/v1/auth/oauth2/authorize`,
    )
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "ctxpipe:read offline_access",
      state: "ban-test",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${baseUrl}/mcp`,
    }).toString()
    const authorize = await app.request(authorizeUrl.toString(), {
      headers: { cookie: seed.cookie, origin: baseUrl },
      redirect: "manual",
    })
    let callback = new URL(authorize.headers.get("location") ?? "", baseUrl)
    if (callback.pathname === "/.auth/consent") {
      const consent = await app.request(
        `${baseUrl}/.auth/api/v1/auth/oauth2/consent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: seed.cookie,
            origin: baseUrl,
            "x-ctxpipe-oauth-organization": seed.orgId,
          },
          body: JSON.stringify({
            accept: true,
            oauth_query: callback.search.slice(1),
          }),
        },
      )
      callback = new URL(((await consent.json()) as { url: string }).url)
    }
    const code = callback.searchParams.get("code")
    if (!code) throw new Error("the authorization flow gave no code")
    const token = await app.request(
      `${baseUrl}/.auth/api/v1/auth/oauth2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: baseUrl,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
          resource: `${baseUrl}/mcp`,
        }).toString(),
      },
    )
    const body = (await token.json()) as {
      access_token?: string
      refresh_token?: string
    }
    if (!body.access_token || !body.refresh_token)
      throw new Error("the token request gave no tokens")
    return { accessToken: body.access_token, refreshToken: body.refresh_token }
  }

  function refresh() {
    return app.request(`${baseUrl}/.auth/api/v1/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: oauthClientId,
        resource: `${baseUrl}/mcp`,
      }).toString(),
    })
  }

  function signIn() {
    return getAuth().api.signInEmail({
      body: { email: seed.email, password: PASSWORD },
      headers: new Headers({ origin: baseUrl }),
      asResponse: true,
    })
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    ;({ app, baseUrl } = createApp())
    const db = getSystemDb()
    const [session] = await db
      .select({ id: sessions.id, token: sessions.token })
      .from(sessions)
      .where(eq(sessions.userId, seed.userId))
      .limit(1)
    if (!session) throw new Error("sign-up stored no session")

    oauthClientId = await registerClient()
    const tokens = await oauthTokens(oauthClientId)
    refreshToken = tokens.refreshToken

    // An opaque access token, as an OAuth client without a JWT gets it.
    const opaque = `opaque_${randomUUID()}`
    await db.insert(oauthAccessTokens).values({
      id: generateObjectId("oat"),
      token: createHash("sha256").update(opaque).digest("base64url"),
      clientId: oauthClientId,
      sessionId: session.id,
      userId: seed.userId,
      referenceId: seed.orgId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      scopes: ["ctxpipe:read"],
    })

    // A device login of the CLI that the user approved and did not redeem.
    const started = await getAuth().api.deviceCode({
      body: { client_id: DEVICE_LOGIN_CLIENT_ID },
    })
    deviceCode = started.device_code
    const signedIn = new Headers({ cookie: seed.cookie, origin: baseUrl })
    await getAuth().api.deviceVerify({
      query: { user_code: started.user_code },
      headers: signedIn,
    })
    await getAuth().api.deviceApprove({
      body: { userCode: started.user_code },
      headers: signedIn,
    })

    Object.assign(credentials, {
      cookie: { cookie: seed.cookie },
      "personal API key": { "x-api-key": seed.personalApiKey },
      "personal API key as Bearer": {
        authorization: `Bearer ${seed.personalApiKey}`,
      },
      "session token as Bearer": { authorization: `Bearer ${session.token}` },
      "OAuth JWT access token": {
        authorization: `Bearer ${tokens.accessToken}`,
      },
      "OAuth opaque access token": { authorization: `Bearer ${opaque}` },
    })
  })

  afterAll(async () => {
    await getSystemDb()
      .delete(oauthClients)
      .where(eq(oauthClients.clientId, oauthClientId))
    if (seed) await cleanupSeededOrg(seed)
  })

  it("refuses each credential of a banned user on each request, and none after the ban ends", async () => {
    const accepted = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(credentials).map(async ([kind, headers]) => [
            kind,
            (await call(headers)).status,
          ]),
        ),
      )
    const all = (status: number) =>
      Object.fromEntries(Object.keys(credentials).map((kind) => [kind, status]))
    expect(await accepted()).toEqual(all(200))

    // The flag alone, without the job's revocation: the request check.
    await setBan(true)
    expect(await accepted()).toEqual(all(401))
    // An organization API key is the organization's, not the user's.
    expect(
      (await call({ "x-api-key": seed.orgApiKey })).status,
      "org key",
    ).toBe(200)

    await setBan(true, new Date(Date.now() - 1000))
    expect(await accepted()).toEqual(all(200))
    await setBan(false)
  })

  it("refuses a new session to a banned user, and clears a ban that ended", async () => {
    await setBan(true)
    const refused = await signIn()
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: "BANNED_USER" })

    await setBan(true, new Date(Date.now() - 1000))
    expect((await signIn()).status).toBe(200)
    const [user] = await getSystemDb()
      .select({ banned: users.banned, banExpires: users.banExpires })
      .from(users)
      .where(eq(users.id, seed.userId))
    expect(user).toEqual({ banned: false, banExpires: null })
  })

  it("the ban job revokes each credential: sessions, keys, OAuth tokens, device logins", async () => {
    await adminBanUser.fn({
      input: {
        requestId: randomUUID(),
        requestedBy: { kind: "operator", email: "operator@example.com" },
        approvedBy: "approver@example.com",
        params: { userId: seed.userId, reason: "Test ban" },
      },
      step: { run: (_: unknown, work: () => unknown) => work() } as never,
      version: null,
      run: { id: "run_ban_test" } as never,
    })
    const db = getSystemDb()
    const where = <T extends { userId: unknown }>(table: T) =>
      eq(table.userId as never, seed.userId)
    expect(await db.select().from(sessions).where(where(sessions))).toEqual([])
    const keys = await db
      .select({ configId: apikeys.configId, enabled: apikeys.enabled })
      .from(apikeys)
      .where(eq(apikeys.referenceId, seed.userId))
    expect(keys).toEqual([{ configId: "default", enabled: false }])
    for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
      const rows = await db
        .select({ revoked: table.revoked })
        .from(table)
        .where(where(table))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.revoked !== null)).toBe(true)
    }
    const [device] = await db
      .select({ status: deviceCodes.status })
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCode, deviceCode))
    expect(device?.status).toBe("denied")

    // Each way to get a new credential is closed too.
    expect((await refresh()).ok).toBe(false)
    const redeem = await getAuth()
      .api.deviceToken({
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: DEVICE_LOGIN_CLIENT_ID,
        },
      })
      .then(
        () => "redeemed",
        () => "refused",
      )
    expect(redeem).toBe("refused")
    expect((await signIn()).status).toBe(403)
  })
})
