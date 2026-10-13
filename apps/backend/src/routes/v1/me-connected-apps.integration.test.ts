import { OpenAPIHono } from "@hono/zod-openapi"
import { eq, inArray } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
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
    init: { method?: string; body?: unknown; apiKey?: boolean } = {},
  ) {
    const headers: Record<string, string> = init.apiKey
      ? { "x-api-key": seed?.personalApiKey ?? "" }
      : { cookie: seed?.cookie ?? "" }
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

  /** A grant of `userId` with a consent, an access token and a refresh token. */
  async function newGrant(userId: string, orgIds: string[]): Promise<string> {
    const grantId = generateObjectId("ogr")
    grantIds.push(grantId)
    await setOrganizations({ grantId }, orgIds)
    const db = getSystemDb()
    const now = new Date()
    await db.insert(oauthConsents).values({
      id: generateObjectId("ocs"),
      clientId,
      userId,
      referenceId: grantId,
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
      referenceId: grantId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      scopes: ["openid", "ctxpipe:read"],
    })
    await db.insert(oauthAccessTokens).values({
      id: generateObjectId("oat"),
      token: `access_${grantId}`,
      clientId,
      userId,
      referenceId: grantId,
      refreshId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      scopes: ["openid", "ctxpipe:read"],
    })
    return grantId
  }

  async function grantOrgIds(grantId: string): Promise<string[]> {
    const rows = await getSystemDb()
      .select({ id: oauthGrantOrganizations.organizationId })
      .from(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.grantId, grantId))
    return rows.map((row) => row.id).sort()
  }

  async function tokenCount(grantId: string): Promise<number> {
    const db = getSystemDb()
    const access = await db
      .select({ id: oauthAccessTokens.id })
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.referenceId, grantId))
    const refresh = await db
      .select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.referenceId, grantId))
    const consents = await db
      .select({ id: oauthConsents.id })
      .from(oauthConsents)
      .where(eq(oauthConsents.referenceId, grantId))
    return access.length + refresh.length + consents.length
  }

  type AppJson = {
    grantId: string
    clientName: string | null
    scopes: string[]
    organizations: { id: string; slug: string }[]
  }

  it("lists only the grants of the signed-in user, with client name, scopes and orgs", async () => {
    const own = await newGrant(seedU?.userId ?? "", [orgA, orgB])
    const foreign = await newGrant(seedV?.userId ?? "", [orgC])
    const response = await request(seedU, "")
    expect(response.status).toBe(200)
    const { apps } = (await response.json()) as { apps: AppJson[] }
    const ids = apps.map((app) => app.grantId)
    expect(ids).toContain(own)
    expect(ids).not.toContain(foreign)
    const app = apps.find((entry) => entry.grantId === own)
    expect(app).toMatchObject({
      clientName: "Example Agent",
      scopes: ["openid", "ctxpipe:read"],
    })
    expect(app?.organizations.map((org) => org.id).sort()).toEqual(
      [orgA, orgB].sort(),
    )
  })

  it("does not list a legacy consent with an org-id reference", async () => {
    const now = new Date()
    const legacyId = generateObjectId("ocs")
    await getSystemDb()
      .insert(oauthConsents)
      .values({
        id: legacyId,
        clientId,
        userId: seedU?.userId ?? "",
        referenceId: orgA,
        scopes: ["openid"],
        createdAt: now,
        updatedAt: now,
      })
    try {
      const { apps } = (await (await request(seedU, "")).json()) as {
        apps: AppJson[]
      }
      expect(apps.map((app) => app.grantId)).not.toContain(orgA)
    } finally {
      await getSystemDb()
        .delete(oauthConsents)
        .where(eq(oauthConsents.id, legacyId))
    }
  })

  it("sets the org set of an own grant exactly", async () => {
    const grantId = await newGrant(seedU?.userId ?? "", [orgA])
    const response = await request(seedU, `/${grantId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgB] },
    })
    expect(response.status).toBe(200)
    const app = (await response.json()) as AppJson
    expect(app.organizations.map((org) => org.id)).toEqual([orgB])
    expect(await grantOrgIds(grantId)).toEqual([orgB])
  })

  it("refuses an empty org set and keeps the old set", async () => {
    const grantId = await newGrant(seedU?.userId ?? "", [orgA])
    const response = await request(seedU, `/${grantId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [] },
    })
    expect(response.status).toBe(400)
    expect(await grantOrgIds(grantId)).toEqual([orgA])
  })

  it("refuses to add an org the user is not a member of and keeps the old set", async () => {
    const grantId = await newGrant(seedU?.userId ?? "", [orgA])
    const response = await request(seedU, `/${grantId}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgA, orgC] },
    })
    expect(response.status).toBe(400)
    expect(await grantOrgIds(grantId)).toEqual([orgA])
  })

  it("gives 404 for the grant of another user and for an unknown grant, and changes nothing", async () => {
    const foreign = await newGrant(seedV?.userId ?? "", [orgC])
    const edit = await request(seedU, `/${foreign}/organizations`, {
      method: "PUT",
      body: { organizationIds: [orgA] },
    })
    const unknown = await request(
      seedU,
      `/${generateObjectId("ogr")}/organizations`,
      { method: "PUT", body: { organizationIds: [orgA] } },
    )
    const revoke = await request(seedU, `/${foreign}`, { method: "DELETE" })
    expect(edit.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(revoke.status).toBe(404)
    expect(await edit.json()).toEqual(await unknown.json())
    expect(await grantOrgIds(foreign)).toEqual([orgC])
    expect(await tokenCount(foreign)).toBe(3)
  })

  it("gives 404 for a legacy org-id reference", async () => {
    const response = await request(seedU, `/${orgA}`, { method: "DELETE" })
    expect(response.status).toBe(404)
  })

  it("revokes an own grant: its consent, tokens and org set go, another user's grant stays", async () => {
    const own = await newGrant(seedU?.userId ?? "", [orgA, orgB])
    const foreign = await newGrant(seedV?.userId ?? "", [orgC])
    const response = await request(seedU, `/${own}`, { method: "DELETE" })
    expect(response.status).toBe(204)
    expect(await tokenCount(own)).toBe(0)
    expect(await grantOrgIds(own)).toEqual([])
    expect(await tokenCount(foreign)).toBe(3)
    expect(await grantOrgIds(foreign)).toEqual([orgC])
    const { apps } = (await (await request(seedU, "")).json()) as {
      apps: AppJson[]
    }
    expect(apps.map((app) => app.grantId)).not.toContain(own)
  })

  it("refuses a personal API key: only a signed-in session manages grants", async () => {
    const grantId = await newGrant(seedU?.userId ?? "", [orgA])
    const list = await request(seedU, "", { apiKey: true })
    const revoke = await request(seedU, `/${grantId}`, {
      method: "DELETE",
      apiKey: true,
    })
    expect(list.status).toBe(403)
    expect(revoke.status).toBe(403)
    expect(await tokenCount(grantId)).toBe(3)
  })

  it("refuses a request with no credential", async () => {
    const response = await createApp().request(
      "http://backend.test/api/v1/me/connected-apps",
    )
    expect(response.status).toBe(401)
  })
})
