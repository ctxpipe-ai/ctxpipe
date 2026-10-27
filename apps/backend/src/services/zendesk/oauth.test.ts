import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { isZendeskSubdomain } from "../../lib/connection-config.js"
import {
  createZendeskOAuthState,
  exchangeZendeskCode,
  refreshZendeskToken,
  verifyZendeskOAuthState,
  ZendeskAuthorizationRevokedError,
  zendeskAuthorizeUrl,
} from "./oauth.js"

const secret = "a-test-auth-secret-of-enough-length-000"
const creds = { clientId: "ctx-client", clientSecret: "client-secret" }
const redirectUri =
  "https://app.example.com/api/v1/integrations/zendesk/callback"
const bodies: unknown[] = []
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  bodies.length = 0
})
afterAll(() => server.close())

describe("Zendesk OAuth state", () => {
  const input = {
    authSecret: secret,
    orgId: "org_1",
    orgSlug: "acme",
    userId: "user_1",
    connectionId: "con_1",
    now: 1_000,
  }

  it("binds the org, the user, and the connection", () => {
    const { state, nonce } = createZendeskOAuthState(input)
    expect(
      verifyZendeskOAuthState({ authSecret: secret, state, now: 2_000 }),
    ).toMatchObject({
      orgId: "org_1",
      userId: "user_1",
      connectionId: "con_1",
      nonce,
    })
  })

  it("refuses an expired, a changed, or a foreign state", () => {
    const { state } = createZendeskOAuthState(input)
    const later = 1_000 + 10 * 60 * 1000 + 1
    expect(
      verifyZendeskOAuthState({ authSecret: secret, state, now: later }),
    ).toBeUndefined()
    expect(
      verifyZendeskOAuthState({
        authSecret: secret,
        state: `${state}x`,
        now: 2_000,
      }),
    ).toBeUndefined()
    expect(
      verifyZendeskOAuthState({
        authSecret: `${secret}-other`,
        state,
        now: 2_000,
      }),
    ).toBeUndefined()
  })
})

describe("isZendeskSubdomain", () => {
  it.each([
    ["acme", true],
    ["acme-support", true],
    ["acme.evil.example", false],
    ["acme/../x", false],
    ["Acme", false],
    ["", false],
  ])("checks %s", (value, ok) => {
    expect(isZendeskSubdomain(value)).toBe(ok)
  })
})

describe("zendeskAuthorizeUrl", () => {
  it("asks for the read scopes and webhook management, with PKCE", () => {
    const url = new URL(
      zendeskAuthorizeUrl({
        subdomain: "acme",
        clientId: "ctx-client",
        redirectUri,
        state: "the-state",
        codeChallenge: "the-challenge",
      }),
    )
    expect(url.origin + url.pathname).toBe(
      "https://acme.zendesk.com/oauth/authorizations/new",
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "ctx-client",
      redirect_uri: redirectUri,
      scope:
        "hc:read tickets:read ticket_views:read users:read webhooks:read webhooks:write",
      state: "the-state",
      code_challenge: "the-challenge",
      code_challenge_method: "S256",
    })
  })
})

const tokens = (access: string, refresh: string) =>
  HttpResponse.json({
    access_token: access,
    refresh_token: refresh,
    expires_in: 1800,
    token_type: "bearer",
  })

describe("Zendesk token requests", () => {
  it("exchanges the code with the PKCE verifier", async () => {
    server.use(
      http.post(
        "https://acme.zendesk.com/oauth/tokens",
        async ({ request }) => {
          bodies.push(await request.json())
          return tokens("access-1", "refresh-1")
        },
      ),
    )
    expect(
      await exchangeZendeskCode({
        subdomain: "acme",
        creds,
        code: "the-code",
        codeVerifier: "the-verifier",
        redirectUri,
        now: Date.parse("2026-10-14T00:00:00Z"),
      }),
    ).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: "2026-10-14T00:30:00.000Z",
    })
    expect(bodies).toEqual([
      {
        grant_type: "authorization_code",
        code: "the-code",
        client_id: "ctx-client",
        client_secret: "client-secret",
        redirect_uri: redirectUri,
        scope:
          "hc:read tickets:read ticket_views:read users:read webhooks:read webhooks:write",
        code_verifier: "the-verifier",
      },
    ])
  })

  it("refreshes to a new pair of tokens", async () => {
    server.use(
      http.post(
        "https://acme.zendesk.com/oauth/tokens",
        async ({ request }) => {
          bodies.push(await request.json())
          return tokens("access-2", "refresh-2")
        },
      ),
    )
    const refreshed = await refreshZendeskToken({
      subdomain: "acme",
      creds,
      refreshToken: "refresh-1",
    })
    expect(refreshed).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    })
    expect(bodies).toEqual([
      {
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: "ctx-client",
        client_secret: "client-secret",
      },
    ])
  })

  it("does not follow a redirect of the token request to another host", async () => {
    const stolen: unknown[] = []
    server.use(
      http.post(
        "https://acme.zendesk.com/oauth/tokens",
        () =>
          new HttpResponse(null, {
            status: 307,
            headers: { location: "https://attacker.example/oauth/tokens" },
          }),
      ),
      http.post(
        "https://attacker.example/oauth/tokens",
        async ({ request }) => {
          stolen.push(await request.text())
          return tokens("stolen", "stolen")
        },
      ),
    )
    await expect(
      exchangeZendeskCode({
        subdomain: "acme",
        creds,
        code: "the-code",
        codeVerifier: "the-verifier",
        redirectUri,
      }),
    ).rejects.toSatisfy(
      // The fetch refuses the redirect itself; it does not send a second
      // request that fails later.
      (error) => String((error as Error).cause).includes("unexpected redirect"),
    )
    expect(stolen).toEqual([])
  })

  it("throws a typed error when Zendesk refuses the refresh token", async () => {
    server.use(
      http.post("https://acme.zendesk.com/oauth/tokens", () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    )
    await expect(
      refreshZendeskToken({ subdomain: "acme", creds, refreshToken: "old" }),
    ).rejects.toBeInstanceOf(ZendeskAuthorizationRevokedError)
  })
})
