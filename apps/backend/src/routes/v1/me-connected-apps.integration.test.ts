import { createHash } from "node:crypto"

import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq, inArray } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import { setOrganizations } from "../../auth/oauth-grants.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, initDb } from "../../db/client.js"
import {
  members,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  organizations,
  sessions,
} from "../../db/schema/auth.js"
import { oauthGrantOrganizations } from "../../db/schema/oauth_grant_organizations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

/**
 * User U is a member of org A (own seed) and org B (added row). User V owns
 * org C; U is not a member of C. Each case makes its own grants.
 */
describe("/api/v1/me/connected-apps (Postgres)", () => {
  let seedU: SeededOrg | undefined
  let seedV: SeededOrg | undefined
  let orgA = ""
  let orgB = ""
  let orgC = ""
  let clientId = ""
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const grantIds: string[] = []

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seedU = await seedOrg()
    seedV = await seedOrg()
    orgA = seedU.orgId
    orgC = seedV.orgId
    orgB = generateObjectId("org")
    const db = getSystemDb()
    await db.insert(organizations).values({
      id: orgB,
      name: `Apps B ${suffix}`,
      slug: `apps-b-${suffix}`,
      createdAt: new Date(),
    })
    await db.insert(members).values({
      id: generateObjectId("member"),
      organizationId: orgB,
      userId: seedU.userId,
      role: "member",
      createdAt: new Date(),
    })
    clientId = `client_${suffix}`
    await db.insert(oauthClients).values({
      id: generateObjectId("oac"),
      clientId,
      name: "Example Agent",
      redirectUris: ["http://localhost/callback"],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  afterAll(async () => {
    const db = getSystemDb()
    if (grantIds.length > 0) {
      await db
        .delete(oauthGrantOrganizations)
        .where(inArray(oauthGrantOrganizations.grantId, grantIds))
    }
    if (clientId) {
      await db.delete(oauthClients).where(eq(oauthClients.clientId, clientId))
    }
    if (orgB) await db.delete(organizations).where(eq(organizations.id, orgB))
    for (const seed of [seedV, seedU]) {
      if (!seed) continue
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  })

  function createApp() {
    const env = parseEnv(process.env as Record<string, string | undefined>)
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

  function request(
    seed: SeededOrg | undefined,
    path: string,
    init: {
      method?: string
      body?: unknown
      headers?: Record<string, string>
    } = {},
  ) {
    const headers: Record<string, string> = init.headers ?? {
      cookie: seed?.cookie ?? "",
    }
    if (init.body !== undefined) headers["content-type"] = "application/json"
    return createApp().request(
      `http://backend.test/api/v1/me/connected-apps${path}`,
      {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    )
  }

  type Fixture = { consentId: string; referenceId: string }

  /**
   * A consent of `userId` with an access token and a refresh token. With org
   * ids, the reference is a new grant with that org set. With `legacyOrgId`,
   * the reference is that org id (a consent from before multi-org grants).
   */
  async function newConsent(
    userId: string,
    orgIds: string[],
    legacyOrgId?: string,
  ): Promise<Fixture> {
    const referenceId = legacyOrgId ?? generateObjectId("ogr")
    if (!legacyOrgId) {
      grantIds.push(referenceId)
      await setOrganizations({ grantId: referenceId }, orgIds)
    }
    const db = getSystemDb()
    const now = new Date()
    const consentId = generateObjectId("ocs")
    await db.insert(oauthConsents).values({
      id: consentId,
      clientId,
      userId,
      referenceId,
      scopes: ["openid", "ctxpipe:read"],
      createdAt: now,
      updatedAt: now,
    })
    const refreshId = generateObjectId("ort")
    await db.insert(oauthRefreshTokens).values({
      id: refreshId,
      token: `refresh_${refreshId}`,
      clientId,
      userId,
      referenceId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      scopes: ["openid", "ctxpipe:read"],
    })
    await db.insert(oauthAccessTokens).values({
      id: generateObjectId("oat"),
      token: `access_${consentId}`,
      clientId,
      userId,
      referenceId,
      refreshId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      scopes: ["openid", "ctxpipe:read"],
    })
    return { consentId, referenceId }
  }

  async function grantOrgIds(grantId: string): Promise<string[]> {
    const rows = await getSystemDb()
      .select({ id: oauthGrantOrganizations.organizationId })
      .from(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.grantId, grantId))
    return rows.map((row) => row.id).sort()
  }

  /** Consents, access tokens and refresh tokens of one user and reference. */
  async function rowCount(userId: string, referenceId: string) {
    const db = getSystemDb()
    const access = await db
      .select({ id: oauthAccessTokens.id })
      .from(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.referenceId, referenceId),
          eq(oauthAccessTokens.userId, userId),
        ),
      )
    const refresh = await db
      .select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.referenceId, referenceId),
          eq(oauthRefreshTokens.userId, userId),
        ),
      )
    const consents = await db
      .select({ id: oauthConsents.id })
      .from(oauthConsents)
      .where(
        and(
          eq(oauthConsents.referenceId, referenceId),
          eq(oauthConsents.userId, userId),
        ),
      )
    return access.length + refresh.length + consents.length
  }

  type AppJson = {
    id: string
    legacy: boolean
    clientName: string | null
    scopes: string[]
    organizations: { id: string; slug: string }[]
  }

  async function listApps(seed: SeededOrg | undefined): Promise<AppJson[]> {
    const response = await request(seed, "")
    expect(response.status).toBe(200)
    return ((await response.json()) as { apps: AppJson[] }).apps
  }

  const userU = () => seedU?.userId ?? ""
  const userV = () => seedV?.userId ?? ""

  it("lists only the consents of the signed-in user, with client name, scopes and orgs", async () => {
    const own = await newConsent(userU(), [orgA, orgB])
    const foreign = await newConsent(userV(), [orgC])
    const apps = await listApps(seedU)
    const ids = apps.map((app) => app.id)
    expect(ids).toContain(own.consentId)
    expect(ids).not.toContain(foreign.consentId)
    const app = apps.find((entry) => entry.id === own.consentId)
    expect(app).toMatchObject({
      legacy: false,
      clientName: "Example Agent",
      scopes: ["openid", "ctxpipe:read"],
    })
    expect(app?.organizations.map((org) => org.id).sort()).toEqual(
      [orgA, orgB].sort(),
    )
  })

  it("lists a legacy consent with its one org", async () => {
    const legacy = await newConsent(userU(), [], orgA)
    const app = (await listApps(seedU)).find(
      (entry) => entry.id === legacy.consentId,
    )
    expect(app).toMatchObject({ legacy: true })
    expect(app?.organizations.map((org) => org.id)).toEqual([orgA])
  })

  it("lists a null-reference consent as legacy with revoke only", async () => {
    const { consentId } = await newConsent(userU(), [orgA])
    await getSystemDb()
      .update(oauthConsents)
      .set({ referenceId: null })
      .where(eq(oauthConsents.id, consentId))
    expect(
      (await listApps(seedU)).find((app) => app.id === consentId),
    ).toMatchObject({
      legacy: true,
      organizations: [],
    })
    const edit = await request(seedU, `/${consentId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgB] },
    })
    expect(edit.status).toBe(409)
    const revoke = await request(seedU, `/${consentId}`, { method: "DELETE" })
    expect(revoke.status).toBe(204)
    expect((await listApps(seedU)).map((app) => app.id)).not.toContain(
      consentId,
    )
  })

  it("sets the org set of an own grant exactly", async () => {
    const { consentId, referenceId } = await newConsent(userU(), [orgA])
    const response = await request(seedU, `/${consentId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgB] },
    })
    expect(response.status).toBe(204)
    expect(await grantOrgIds(referenceId)).toEqual([orgB])
  })

  it("refuses an empty org set and keeps the old set", async () => {
    const { consentId, referenceId } = await newConsent(userU(), [orgA])
    const response = await request(seedU, `/${consentId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [] },
    })
    expect(response.status).toBe(400)
    expect(await grantOrgIds(referenceId)).toEqual([orgA])
  })

  it("refuses an org the user is not a member of, also one that the set holds already", async () => {
    // The set holds org C, which the user is not a member of.
    const { consentId, referenceId } = await newConsent(userU(), [orgA, orgC])
    const keep = await request(seedU, `/${consentId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgA, orgC] },
    })
    const add = await request(seedU, `/${consentId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgB, orgC] },
    })
    expect(keep.status).toBe(400)
    expect(add.status).toBe(400)
    expect(await grantOrgIds(referenceId)).toEqual([orgA, orgC].sort())
  })

  it("refuses to edit the orgs of a legacy consent", async () => {
    const legacy = await newConsent(userU(), [], orgA)
    const response = await request(
      seedU,
      `/${legacy.consentId}/organizations`,
      { method: "PUT", body: { organizationIds: [orgA, orgB] } },
    )
    expect(response.status).toBe(409)
    expect(await grantOrgIds(orgA)).toEqual([])
  })

  it("gives 404 for the consent of another user and for an unknown id, and changes nothing", async () => {
    const foreign = await newConsent(userV(), [orgC])
    const edit = await request(seedU, `/${foreign.consentId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgA] },
    })
    const unknown = await request(
      seedU,
      `/${generateObjectId("ocs")}/organizations`,
      { method: "PUT", body: { organizationIds: [orgA] } },
    )
    const revoke = await request(seedU, `/${foreign.consentId}`, {
      method: "DELETE",
    })
    expect(edit.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(revoke.status).toBe(404)
    expect(await edit.json()).toEqual(await unknown.json())
    expect(await grantOrgIds(foreign.referenceId)).toEqual([orgC])
    expect(await rowCount(userV(), foreign.referenceId)).toBe(3)
  })

  it("revokes an own grant: its consent, tokens and org set go, another user's grant stays", async () => {
    const own = await newConsent(userU(), [orgA, orgB])
    const foreign = await newConsent(userV(), [orgC])
    const response = await request(seedU, `/${own.consentId}`, {
      method: "DELETE",
    })
    expect(response.status).toBe(204)
    expect(await rowCount(userU(), own.referenceId)).toBe(0)
    expect(await grantOrgIds(own.referenceId)).toEqual([])
    expect(await rowCount(userV(), foreign.referenceId)).toBe(3)
    expect(await grantOrgIds(foreign.referenceId)).toEqual([orgC])
    const ids = (await listApps(seedU)).map((app) => app.id)
    expect(ids).not.toContain(own.consentId)
  })

  it("revokes a legacy consent: only this user's consent and tokens for that client go", async () => {
    const own = await newConsent(userU(), [], orgC)
    const other = await newConsent(userV(), [], orgC)
    const response = await request(seedU, `/${own.consentId}`, {
      method: "DELETE",
    })
    expect(response.status).toBe(204)
    expect(await rowCount(userU(), orgC)).toBe(0)
    expect(await rowCount(userV(), orgC)).toBe(3)
    const ids = (await listApps(seedV)).map((app) => app.id)
    expect(ids).toContain(other.consentId)
  })

  describe("refuses each credential that is not a signed-in session", () => {
    async function opaqueOAuthToken(): Promise<string> {
      const [session] = await getSystemDb()
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userU()))
        .limit(1)
      const raw = `opaque_${generateObjectId("tok")}`
      const { referenceId } = await newConsent(userU(), [orgA])
      await getSystemDb()
        .insert(oauthAccessTokens)
        .values({
          id: generateObjectId("oat"),
          token: createHash("sha256").update(raw).digest("base64url"),
          clientId,
          sessionId: session?.id,
          userId: userU(),
          referenceId,
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt: new Date(),
          scopes: ["ctxpipe:read"],
        })
      return raw
    }

    /** A JWT from the server's own key with no client and no grant claim. */
    async function jwtWithoutClient(): Promise<string> {
      const [session] = await getSystemDb()
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userU()))
        .limit(1)
      const env = parseEnv(process.env as Record<string, string | undefined>)
      const { token } = await getAuth().api.signJWT({
        body: {
          payload: {
            sub: userU(),
            sid: session?.id,
            aud: env.AUTH_BASE_URL,
            // The issuer that withAuth accepts.
            iss: new URL("/.auth/api/v1/auth", env.AUTH_BASE_URL).toString(),
          },
        },
      })
      return token
    }

    async function sessionToken(): Promise<string> {
      const [session] = await getSystemDb()
        .select({ token: sessions.token })
        .from(sessions)
        .where(eq(sessions.userId, userU()))
        .limit(1)
      if (!session) throw new Error("Session fixture is missing")
      return session.token
    }

    const credentials: [string, () => Promise<Record<string, string>>][] = [
      ...["bearer", "Bearer"].map(
        (scheme): [string, () => Promise<Record<string, string>>] => [
          `a ${scheme} session token`,
          async () => ({ authorization: `${scheme} ${await sessionToken()}` }),
        ],
      ),
      ...(
        [
          ["authorization", "Basic example"],
          ["authorization", ""],
          ["x-api-key", ""],
        ] as const
      ).map(
        ([name, value]): [string, () => Promise<Record<string, string>>] => [
          `a cookie with ${name}: ${value}`,
          async () => ({ cookie: seedU?.cookie ?? "", [name]: value }),
        ],
      ),
      [
        "an Authorization header without a session",
        async () => ({ authorization: "Basic example" }),
      ],
      [
        "an empty API key header without a session",
        async () => ({ "x-api-key": "" }),
      ],
      [
        "an opaque OAuth token",
        async () => ({ authorization: `Bearer ${await opaqueOAuthToken()}` }),
      ],
      [
        "a JWT with no client claim",
        async () => ({ authorization: `Bearer ${await jwtWithoutClient()}` }),
      ],
      [
        "a personal API key",
        async () => ({ "x-api-key": seedU?.personalApiKey ?? "" }),
      ],
    ]

    it.each(credentials)(
      "%s gets 403 on GET, PUT and DELETE",
      async (_name, make) => {
        const headers = await make()
        const { consentId, referenceId } = await newConsent(userU(), [orgA])
        const list = await request(seedU, "", { headers })
        const edit = await request(seedU, `/${consentId}/organizations`, {
          method: "PUT",
          body: { organizationIds: [orgB] },
          headers: { ...headers, "content-type": "application/json" },
        })
        const revoke = await request(seedU, `/${consentId}`, {
          method: "DELETE",
          headers,
        })
        expect([list.status, edit.status, revoke.status]).toEqual([
          403, 403, 403,
        ])
        expect(await grantOrgIds(referenceId)).toEqual([orgA])
        expect(await rowCount(userU(), referenceId)).toBe(3)
      },
    )
  })

  it("refuses a request with no credential", async () => {
    const response = await createApp().request(
      "http://backend.test/api/v1/me/connected-apps",
    )
    expect(response.status).toBe(401)
  })
})
