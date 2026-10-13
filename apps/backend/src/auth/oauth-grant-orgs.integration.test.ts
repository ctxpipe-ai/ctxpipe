import { createHash } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb, initDb } from "../db/client.js"
import {
  apikeys,
  members,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  organizations,
  sessions,
} from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { generateObjectId } from "../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../test/hono-test-logger.js"
import { type CallPrincipal, listCallOrgs, resolveCallOrg } from "./call-org.js"
import {
  resolveOAuthGrantReference,
  revokeOAuthGrant,
  setOrganizations,
} from "./oauth-grants.js"
import { isOAuthGrantId } from "./oauth-organization.js"
import {
  requireAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "./withAuth.js"

/**
 * User U is a member of org A (own seed) and org B (added row). Org C exists
 * but U is not a member. Each case builds its own grant id.
 */
describe("multi-org grants (Postgres)", () => {
  let seedA: SeededOrg | undefined
  let seedC: SeededOrg | undefined
  let userId = ""
  let orgA = { id: "", slug: "" }
  let orgB = { id: "", slug: "" }
  let orgC = { id: "", slug: "" }
  let sessionId = ""
  let clientId = ""
  const grantIds: string[] = []

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seedA = await seedOrg()
    seedC = await seedOrg()
    userId = seedA.userId
    orgA = { id: seedA.orgId, slug: seedA.orgSlug }
    orgC = { id: seedC.orgId, slug: seedC.orgSlug }

    const db = getSystemDb()
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    orgB = { id: generateObjectId("org"), slug: `grant-b-${suffix}` }
    await db.insert(organizations).values({
      id: orgB.id,
      name: `Grant B ${suffix}`,
      slug: orgB.slug,
      createdAt: new Date(),
    })
    await db.insert(members).values({
      id: generateObjectId("member"),
      organizationId: orgB.id,
      userId,
      role: "member",
      createdAt: new Date(),
    })

    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .limit(1)
    if (!session) throw new Error("sign-up did not store a session")
    sessionId = session.id
    clientId = `client_${suffix}`
    await db.insert(oauthClients).values({
      id: generateObjectId("oac"),
      clientId,
      redirectUris: ["http://localhost/callback"],
      createdAt: new Date(),
      updatedAt: new Date(),
      userId,
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
    if (orgB.id) {
      await db.delete(organizations).where(eq(organizations.id, orgB.id))
    }
    for (const seed of [seedC, seedA]) {
      if (!seed) continue
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  })

  async function newGrant(orgIds: string[]): Promise<string> {
    const grantId = generateObjectId("ogr")
    grantIds.push(grantId)
    await setOrganizations({ grantId }, orgIds)
    return grantId
  }

  function oauth(referenceId: string | null): CallPrincipal {
    return {
      kind: "user",
      userId,
      oauthReferenceId: referenceId,
      personalApiKeyId: null,
    }
  }

  async function addMemberB(): Promise<void> {
    await getSystemDb()
      .insert(members)
      .values({
        id: generateObjectId("member"),
        organizationId: orgB.id,
        userId,
        role: "member",
        createdAt: new Date(),
      })
  }

  async function removeMemberB(): Promise<void> {
    await getSystemDb()
      .delete(members)
      .where(
        and(eq(members.organizationId, orgB.id), eq(members.userId, userId)),
      )
  }

  it("allows each org in the grant set when the user is a member", async () => {
    const grantId = await newGrant([orgA.id, orgB.id])
    expect(await resolveCallOrg(oauth(grantId), orgA.slug)).toEqual({
      ok: true,
      org: orgA,
    })
    expect(await resolveCallOrg(oauth(grantId), orgB.slug)).toEqual({
      ok: true,
      org: orgB,
    })
  })

  it("gives the same org_not_found for an org outside the set, an unknown org, and a foreign org", async () => {
    const grantId = await newGrant([orgA.id])
    const outside = await resolveCallOrg(oauth(grantId), orgB.slug)
    const unknown = await resolveCallOrg(oauth(grantId), "no-such-org-slug")
    const foreign = await resolveCallOrg(oauth(grantId), orgC.slug)
    expect(outside).toEqual({ ok: false, error: "org_not_found" })
    expect(unknown).toEqual(outside)
    expect(foreign).toEqual(outside)
  })

  it("does not allow an org in the set when the user is not a member", async () => {
    const grantId = await newGrant([orgA.id, orgC.id])
    expect(await resolveCallOrg(oauth(grantId), orgC.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
  })

  it("denies the next call after the membership is removed", async () => {
    const grantId = await newGrant([orgA.id, orgB.id])
    expect((await resolveCallOrg(oauth(grantId), orgB.slug)).ok).toBe(true)
    await removeMemberB()
    try {
      expect(await resolveCallOrg(oauth(grantId), orgB.slug)).toEqual({
        ok: false,
        error: "org_not_found",
      })
      expect((await resolveCallOrg(oauth(grantId), orgA.slug)).ok).toBe(true)
    } finally {
      await addMemberB()
    }
  })

  it("denies an org after it is removed from the set, with no new token", async () => {
    const grantId = await newGrant([orgA.id, orgB.id])
    await setOrganizations({ grantId }, [orgA.id])
    expect(await resolveCallOrg(oauth(grantId), orgB.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
    expect((await resolveCallOrg(oauth(grantId), orgA.slug)).ok).toBe(true)
  })

  it("denies every org after the grant is revoked", async () => {
    const grantId = await newGrant([orgA.id, orgB.id])
    await revokeOAuthGrant({ grantId, userId })
    expect(await resolveCallOrg(oauth(grantId), orgA.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
    expect(await resolveCallOrg(oauth(grantId), undefined)).toEqual({
      ok: false,
      error: "org_not_found",
    })
  })

  it("reads a legacy referenceId (an org id) as a one-org set", async () => {
    expect(await resolveCallOrg(oauth(orgA.id), orgA.slug)).toEqual({
      ok: true,
      org: orgA,
    })
    expect(await resolveCallOrg(oauth(orgA.id), undefined)).toEqual({
      ok: true,
      org: orgA,
    })
    expect(await resolveCallOrg(oauth(orgA.id), orgB.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
  })

  it("uses the only org of a one-org grant when the call names no org", async () => {
    const one = await newGrant([orgB.id])
    expect(await resolveCallOrg(oauth(one), undefined)).toEqual({
      ok: true,
      org: orgB,
    })
    const two = await newGrant([orgA.id, orgB.id])
    expect(await resolveCallOrg(oauth(two), undefined)).toEqual({
      ok: false,
      error: "org_required",
    })
  })

  it("denies an org API key that names another org", async () => {
    const principal: CallPrincipal = { kind: "org_api_key", orgId: orgA.id }
    expect(await resolveCallOrg(principal, orgA.slug)).toEqual({
      ok: true,
      org: orgA,
    })
    expect(await resolveCallOrg(principal, undefined)).toEqual({
      ok: true,
      org: orgA,
    })
    expect(await resolveCallOrg(principal, orgB.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
    expect(await resolveCallOrg(principal, "no-such-org-slug")).toEqual({
      ok: false,
      error: "org_not_found",
    })
  })

  it("limits a personal API key with an org set, and keeps every membership without one", async () => {
    const [key] = await getSystemDb()
      .select({ id: apikeys.id })
      .from(apikeys)
      .where(
        and(eq(apikeys.referenceId, userId), eq(apikeys.configId, "default")),
      )
      .limit(1)
    if (!key) throw new Error("seed did not store a personal API key")
    const principal: CallPrincipal = {
      kind: "user",
      userId,
      oauthReferenceId: null,
      personalApiKeyId: key.id,
    }
    expect((await resolveCallOrg(principal, orgA.slug)).ok).toBe(true)
    expect((await resolveCallOrg(principal, orgB.slug)).ok).toBe(true)
    expect(await resolveCallOrg(principal, orgC.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
    expect(await resolveCallOrg(principal, undefined)).toEqual({
      ok: false,
      error: "org_required",
    })
    await setOrganizations({ apiKeyId: key.id }, [orgA.id])
    try {
      expect(await resolveCallOrg(principal, orgB.slug)).toEqual({
        ok: false,
        error: "org_not_found",
      })
      expect(await resolveCallOrg(principal, orgA.slug)).toEqual({
        ok: true,
        org: orgA,
      })
      expect(await resolveCallOrg(principal, undefined)).toEqual({
        ok: true,
        org: orgA,
      })
    } finally {
      await setOrganizations({ apiKeyId: key.id }, [])
    }
  })

  it("stores each row for exactly one grant or one API key", async () => {
    const [key] = await getSystemDb()
      .select({ id: apikeys.id })
      .from(apikeys)
      .where(eq(apikeys.referenceId, userId))
      .limit(1)
    if (!key) throw new Error("seed did not store a personal API key")
    const db = getSystemDb()
    await expect(
      db.insert(oauthGrantOrganizations).values({ organizationId: orgA.id }),
    ).rejects.toThrow()
    await expect(
      db.insert(oauthGrantOrganizations).values({
        grantId: generateObjectId("ogr"),
        apiKeyId: key.id,
        organizationId: orgA.id,
      }),
    ).rejects.toThrow()
    const grantId = generateObjectId("ogr")
    grantIds.push(grantId)
    await db
      .insert(oauthGrantOrganizations)
      .values({ grantId, organizationId: orgA.id })
    await expect(
      db
        .insert(oauthGrantOrganizations)
        .values({ grantId, organizationId: orgA.id }),
    ).rejects.toThrow()
  })

  it("lets a cookie session use any org the user is a member of", async () => {
    const session: CallPrincipal = {
      kind: "user",
      userId,
      oauthReferenceId: null,
      personalApiKeyId: null,
    }
    expect((await resolveCallOrg(session, orgB.slug)).ok).toBe(true)
    expect(await resolveCallOrg(session, orgC.slug)).toEqual({
      ok: false,
      error: "org_not_found",
    })
  })

  it("lists the grant set ∩ live membership in slug order, for the server instructions", async () => {
    const both = await newGrant([orgA.id, orgB.id, orgC.id])
    const listed = await listCallOrgs(oauth(both))
    // orgC is in the set, but the user is not a member of it.
    expect(listed).toEqual(
      [orgA, orgB]
        .map((org) => ({ id: org.id, slug: org.slug }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    )
    await removeMemberB()
    try {
      expect(await listCallOrgs(oauth(both))).toEqual([
        { id: orgA.id, slug: orgA.slug },
      ])
    } finally {
      await addMemberB()
    }
    expect(await listCallOrgs(oauth(orgA.id))).toEqual([
      { id: orgA.id, slug: orgA.slug },
    ])
    expect(await listCallOrgs({ kind: "org_api_key", orgId: orgB.id })).toEqual(
      [{ id: orgB.id, slug: orgB.slug }],
    )
    expect(await listCallOrgs(null)).toEqual([])
  })

  describe("consent grant reference", () => {
    async function addConsent(referenceId: string, client = clientId) {
      await getSystemDb()
        .insert(oauthConsents)
        .values({
          id: generateObjectId("oacs"),
          clientId: client,
          userId,
          referenceId,
          scopes: ["openid"],
          createdAt: new Date(),
          updatedAt: new Date(),
        })
    }

    async function grantOrgIds(grantId: string): Promise<string[]> {
      const rows = await getSystemDb()
        .select({ id: oauthGrantOrganizations.organizationId })
        .from(oauthGrantOrganizations)
        .where(eq(oauthGrantOrganizations.grantId, grantId))
      return rows.map((row) => row.id).sort()
    }

    async function withClient(run: (client: string) => Promise<void>) {
      const client = `${clientId}_${Math.random().toString(36).slice(2, 8)}`
      await getSystemDb()
        .insert(oauthClients)
        .values({
          id: generateObjectId("oac"),
          clientId: client,
          redirectUris: ["http://localhost/callback"],
          createdAt: new Date(),
          updatedAt: new Date(),
          userId,
        })
      try {
        await run(client)
      } finally {
        await getSystemDb()
          .delete(oauthClients)
          .where(eq(oauthClients.clientId, client))
      }
    }

    it("returns the org id and makes no grant outside the consent request", async () => {
      await withClient(async (client) => {
        expect(
          await resolveOAuthGrantReference({
            userId,
            clientId: client,
            organizationIds: [orgA.id],
            consent: false,
          }),
        ).toBe(orgA.id)
        expect(
          await resolveOAuthGrantReference({
            userId,
            clientId: null,
            organizationIds: [orgA.id],
            consent: false,
          }),
        ).toBe(orgA.id)
      })
    })

    it("refuses to make a grant in a consent request with no client id", async () => {
      await expect(
        resolveOAuthGrantReference({
          userId,
          clientId: null,
          organizationIds: [orgA.id],
          consent: true,
        }),
      ).rejects.toThrow()
    })

    it("returns the newest consent reference outside the consent request", async () => {
      await withClient(async (client) => {
        const grantId = await newGrant([orgA.id, orgB.id])
        await addConsent(grantId, client)
        expect(
          await resolveOAuthGrantReference({
            userId,
            clientId: client,
            organizationIds: [orgB.id],
            consent: false,
          }),
        ).toBe(grantId)
      })
    })

    it("sets the grant to exactly the selected orgs on a new consent", async () => {
      await withClient(async (client) => {
        const grantId = await newGrant([orgA.id, orgB.id])
        await addConsent(grantId, client)
        expect(
          await resolveOAuthGrantReference({
            userId,
            clientId: client,
            organizationIds: [orgA.id],
            consent: true,
          }),
        ).toBe(grantId)
        expect(await grantOrgIds(grantId)).toEqual([orgA.id])
      })
    })

    it("makes a new grant on consent when the newest consent is legacy", async () => {
      await withClient(async (client) => {
        await addConsent(orgA.id, client)
        const grantId = await resolveOAuthGrantReference({
          userId,
          clientId: client,
          organizationIds: [orgB.id],
          consent: true,
        })
        grantIds.push(grantId)
        expect(isOAuthGrantId(grantId)).toBe(true)
        expect(await grantOrgIds(grantId)).toEqual([orgB.id])
      })
    })
  })

  describe("revokeOAuthGrant", () => {
    it("refuses a legacy org id reference", async () => {
      await expect(
        revokeOAuthGrant({ grantId: orgA.id, userId }),
      ).rejects.toThrow()
    })

    it("deletes only the consents and tokens of that user", async () => {
      const grantId = await newGrant([orgA.id])
      const otherUserId = seedC?.userId ?? ""
      const db = getSystemDb()
      for (const owner of [userId, otherUserId]) {
        await db.insert(oauthConsents).values({
          id: generateObjectId("oacs"),
          clientId,
          userId: owner,
          referenceId: grantId,
          scopes: ["openid"],
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      }
      await revokeOAuthGrant({ grantId, userId })
      const left = await db
        .select({ userId: oauthConsents.userId })
        .from(oauthConsents)
        .where(eq(oauthConsents.referenceId, grantId))
      expect(left).toEqual([{ userId: otherUserId }])
      expect(await resolveCallOrg(oauth(grantId), orgA.slug)).toEqual({
        ok: false,
        error: "org_not_found",
      })
      await db
        .delete(oauthConsents)
        .where(eq(oauthConsents.referenceId, grantId))
    })
  })

  describe("over HTTP", () => {
    function createApp() {
      const app = new Hono<AppEnv>()
      app.use(contextStorage())
      app.use(evlog())
      app.use(withTestRequestLogger)
      app.use("*", async (c, next) => {
        c.set(
          "env",
          parseEnv(process.env as Record<string, string | undefined>),
        )
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
        withMcpBearerAuth,
        withCookieAuth,
        withOrgApiKeyAuth,
        requireAuth,
        withNetworkOrgContext,
      )
      app.post("/mcp", (c) => c.json({ orgId: c.get("orgId") }))
      return app
    }

    async function opaqueTokenFor(referenceId: string): Promise<string> {
      const token = `opaque_${generateObjectId("tok")}`
      await getSystemDb()
        .insert(oauthAccessTokens)
        .values({
          id: generateObjectId("oat"),
          token: createHash("sha256").update(token).digest("base64url"),
          clientId,
          sessionId,
          userId,
          referenceId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          createdAt: new Date(),
          scopes: ["openid"],
        })
      return token
    }

    async function call(token: string, orgSlug?: string) {
      const query = orgSlug ? `?orgSlug=${orgSlug}` : ""
      return createApp().request(`http://backend.test/mcp${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })
    }

    it("lets one token reach each org in its grant", async () => {
      const grantId = await newGrant([orgA.id, orgB.id])
      const token = await opaqueTokenFor(grantId)
      const a = await call(token, orgA.slug)
      expect(a.status).toBe(200)
      expect(await a.json()).toEqual({ orgId: orgA.id })
      const b = await call(token, orgB.slug)
      expect(b.status).toBe(200)
      expect(await b.json()).toEqual({ orgId: orgB.id })
    })

    it("denies the same token after an untick, and the same way as an unknown org", async () => {
      const grantId = await newGrant([orgA.id, orgB.id])
      const token = await opaqueTokenFor(grantId)
      await setOrganizations({ grantId }, [orgA.id])
      const unticked = await call(token, orgB.slug)
      const unknown = await call(token, "no-such-org-slug")
      expect(unticked.status).toBe(404)
      expect(unknown.status).toBe(404)
      expect(await unticked.json()).toEqual(await unknown.json())
    })

    it("asks for an org when a multi-org grant call names none", async () => {
      const grantId = await newGrant([orgA.id, orgB.id])
      const token = await opaqueTokenFor(grantId)
      const response = await call(token)
      expect(response.status).toBe(400)
    })

    it("keeps a legacy org-bound token working", async () => {
      const token = await opaqueTokenFor(orgA.id)
      const response = await call(token)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ orgId: orgA.id })
      expect((await call(token, orgB.slug)).status).toBe(404)
    })

    it("lets a personal API key reach a named membership and asks for an org without one", async () => {
      const key = seedA?.personalApiKey ?? ""
      const named = await createApp().request(
        `http://backend.test/mcp?orgSlug=${orgB.slug}`,
        { method: "POST", headers: { "x-api-key": key } },
      )
      expect(named.status).toBe(200)
      expect(await named.json()).toEqual({ orgId: orgB.id })
      const bare = await createApp().request("http://backend.test/mcp", {
        method: "POST",
        headers: { "x-api-key": key },
      })
      expect(bare.status).toBe(400)
      const foreign = await createApp().request(
        `http://backend.test/mcp?orgSlug=${orgC.slug}`,
        { method: "POST", headers: { "x-api-key": key } },
      )
      expect(foreign.status).toBe(404)
    })

    it("denies an org API key that names another org", async () => {
      const response = await createApp().request(
        `http://backend.test/mcp?orgSlug=${orgB.slug}`,
        {
          method: "POST",
          headers: { "x-api-key": seedA?.orgApiKey ?? "" },
        },
      )
      expect(response.status).toBe(404)
    })
  })
})
