import { createHash, randomBytes } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
} from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { registerAuthRoutes } from "../routes/auth.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../test/hono-test-logger.js"
import { isOAuthGrantId } from "./oauth-organization.js"

/**
 * The real Better Auth authorize → consent → token flow through the Hono
 * auth routes. It proves that the first connect makes exactly one grant, that
 * a second authorize reuses it with no consent loop, and that a skipConsent
 * client gets a one-org reference with no grant row.
 */
describe("OAuth grant consent flow (Postgres)", () => {
  let seed: SeededOrg | undefined
  let base = ""
  const redirectUri = "http://localhost:4567/callback"

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seed = await seedOrg()
    base = `${parseEnv(process.env as Record<string, string | undefined>).AUTH_BASE_URL.replace(/\/$/, "")}/.auth/api/v1/auth`
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  function createApp() {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(withTestRequestLogger)
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
    registerAuthRoutes(app)
    return app
  }

  function headers(extra: Record<string, string> = {}): Headers {
    const origin = new URL(base).origin
    return new Headers({ cookie: seed?.cookie ?? "", origin, ...extra })
  }

  async function registerClient(): Promise<string> {
    const response = await createApp().request(`${base}/oauth2/register`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        client_name: "Grant flow test",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    })
    expect(response.status).toBeLessThan(300)
    const body = (await response.json()) as { client_id: string }
    return body.client_id
  }

  /** The redirect target of an auth response (Location or JSON `url`). */
  async function redirectOf(response: Response): Promise<URL> {
    const location = response.headers.get("location")
    if (location) return new URL(location, base)
    const body = (await response.json()) as { url?: string }
    if (!body.url) {
      throw new Error(`no redirect: ${response.status} ${JSON.stringify(body)}`)
    }
    return new URL(body.url, base)
  }

  function pkce() {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    return { verifier, challenge }
  }

  async function authorize(clientId: string, challenge: string) {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    const response = await createApp().request(
      `${base}/oauth2/authorize?${query}`,
      { headers: headers() },
    )
    return redirectOf(response)
  }

  async function consent(consentUrl: URL, organizationId: string) {
    const response = await createApp().request(`${base}/oauth2/consent`, {
      method: "POST",
      headers: headers({
        "content-type": "application/json",
        "x-ctxpipe-oauth-organization": organizationId,
      }),
      body: JSON.stringify({
        accept: true,
        oauth_query: consentUrl.search.slice(1),
      }),
    })
    return redirectOf(response)
  }

  async function token(clientId: string, code: string, verifier: string) {
    const response = await createApp().request(`${base}/oauth2/token`, {
      method: "POST",
      headers: headers({
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as { access_token: string }
  }

  async function grantRowsForOrg(orgId: string) {
    return getSystemDb()
      .select({ grantId: oauthGrantOrganizations.grantId })
      .from(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.organizationId, orgId))
  }

  async function accessTokenReference(accessToken: string) {
    const [row] = await getSystemDb()
      .select({ referenceId: oauthAccessTokens.referenceId })
      .from(oauthAccessTokens)
      .where(
        eq(
          oauthAccessTokens.token,
          createHash("sha256").update(accessToken).digest("base64url"),
        ),
      )
    return row?.referenceId ?? null
  }

  it("makes one grant on the first connect and reuses it with no consent loop", async () => {
    const orgId = seed?.orgId ?? ""
    const clientId = await registerClient()
    try {
      const first = pkce()
      const consentUrl = await authorize(clientId, first.challenge)
      expect(consentUrl.pathname).toContain("consent")
      expect(await grantRowsForOrg(orgId)).toEqual([])

      const callback = await consent(consentUrl, orgId)
      const code = callback.searchParams.get("code")
      expect(code).toBeTruthy()
      const grants = await grantRowsForOrg(orgId)
      expect(grants).toHaveLength(1)
      const grantId = grants[0]?.grantId ?? ""
      expect(isOAuthGrantId(grantId)).toBe(true)
      const issued = await token(clientId, code ?? "", first.verifier)
      expect(await accessTokenReference(issued.access_token)).toBe(grantId)

      const second = pkce()
      const again = await authorize(clientId, second.challenge)
      expect(again.origin + again.pathname).toBe(redirectUri)
      const reissued = await token(
        clientId,
        again.searchParams.get("code") ?? "",
        second.verifier,
      )
      expect(await accessTokenReference(reissued.access_token)).toBe(grantId)
      expect(await grantRowsForOrg(orgId)).toEqual(grants)
    } finally {
      await getSystemDb()
        .delete(oauthGrantOrganizations)
        .where(eq(oauthGrantOrganizations.organizationId, orgId))
      await getSystemDb()
        .delete(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
    }
  })

  it("gives a skipConsent client a one-org reference and no grant row", async () => {
    const orgId = seed?.orgId ?? ""
    const clientId = await registerClient()
    try {
      await getSystemDb()
        .update(oauthClients)
        .set({ skipConsent: true })
        .where(eq(oauthClients.clientId, clientId))
      const flow = pkce()
      const callback = await authorize(clientId, flow.challenge)
      expect(callback.origin + callback.pathname).toBe(redirectUri)
      const issued = await token(
        clientId,
        callback.searchParams.get("code") ?? "",
        flow.verifier,
      )
      expect(await accessTokenReference(issued.access_token)).toBe(orgId)
      expect(await grantRowsForOrg(orgId)).toEqual([])
      const consents = await getSystemDb()
        .select({ id: oauthConsents.id })
        .from(oauthConsents)
        .where(
          and(
            eq(oauthConsents.clientId, clientId),
            eq(oauthConsents.userId, seed?.userId ?? ""),
          ),
        )
      expect(consents).toEqual([])
    } finally {
      await getSystemDb()
        .delete(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
    }
  })
})
