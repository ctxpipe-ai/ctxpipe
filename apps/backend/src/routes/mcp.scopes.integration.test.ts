import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"

import { OpenAPIHono } from "@hono/zod-openapi"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { eq, sql } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
import { decodeJwt } from "jose"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import {
  requireAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { oauthAccessTokens, oauthClients, sessions } from "../db/schema/auth.js"
import { generateObjectId } from "../lib/id.js"
import { registerMcpTools } from "../mcp/tools.js"
import { handleMcpTransportRequest } from "../mcp/transport.js"
import { withTestRequestLogger } from "../test/hono-test-logger.js"
import { registerAuthRoutes } from "./auth.js"
import { registerV1Routes } from "./v1/index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

/** The shipped read tools. `listToolNames` sorts, so this list is sorted too. */
const READ_TOOLS = [
  "find_symbol",
  "get_related",
  "list_files",
  "list_workspaces",
  "read_file",
  "search_code",
  "search_knowledge",
]
const WRITE_TOOL = "scope_test_write"

/** The statement of the release migration that gives old OAuth clients the MCP scopes. */
async function migrationSql(): Promise<string> {
  const sql = await readFile(
    new URL(
      "../../migrations/20261016064110_workspaces/migration.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const statement = sql
    .split("--> statement-breakpoint")
    .find((part) => part.includes('UPDATE "oauth_clients"'))
  if (!statement) throw new Error("the MCP scopes data migration is missing")
  return statement
}
const REDIRECT_URI = "http://127.0.0.1:4567/callback"

/**
 * The production `/mcp` chain with the production tools plus one write tool,
 * and the REST routes. No write tool ships yet, so the test adds one to prove
 * that no grant reaches it.
 */
function createApp() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const app = new OpenAPIHono<AppEnv>()
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
  registerV1Routes(app)
  app.all(
    "/mcp",
    withMcpBearerAuth,
    withCookieAuth,
    withOrgApiKeyAuth,
    requireAuth,
    withNetworkOrgContext,
    (c) =>
      handleMcpTransportRequest(c, (server) => {
        registerMcpTools(server)
        server.registerTool(
          WRITE_TOOL,
          {
            title: "Scope test write",
            description: "Changes nothing. Proves the write scope gate.",
            annotations: { readOnlyHint: false },
          },
          async () => ({ content: [{ type: "text", text: "written" }] }),
        )
      }),
  )
  return { app, baseUrl: env.AUTH_BASE_URL.replace(/\/$/, "") }
}

describe("MCP scopes (Postgres)", () => {
  let seed: SeededOrg | undefined
  let app: OpenAPIHono<AppEnv>
  let baseUrl = ""

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    ;({ app, baseUrl } = createApp())
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  function requireSeed(): SeededOrg {
    if (!seed) throw new Error("seedOrg did not run")
    return seed
  }

  function appFetch(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init)
    return Promise.resolve(app.request(request))
  }

  async function listToolNames(
    url: string,
    headers: Record<string, string>,
  ): Promise<string[]> {
    const client = new Client({ name: "scope-test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        fetch: appFetch,
        requestInit: { headers },
      }),
    )
    try {
      const { tools } = await client.listTools()
      return tools.map((tool) => tool.name).sort()
    } finally {
      await client.close()
    }
  }

  function callTool(
    url: string,
    headers: Record<string, string>,
    name: string,
  ) {
    return app.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    })
  }

  async function registerClient(): Promise<string> {
    const register = await app.request(
      `${baseUrl}/.auth/api/v1/auth/oauth2/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({
          client_name: "Scope test host",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      },
    )
    expect(register.status).toBe(200)
    const { client_id: clientId } = (await register.json()) as {
      client_id: string
    }
    return clientId
  }

  /**
   * Real OAuth: authorize with `requestedScope` (`null` sends no `scope`),
   * consent with `grantedScope` (`null` sends no `scope`) when the consent
   * page shows, then token.
   */
  async function oauthAccessToken(
    grantedScope: string | null,
    options: { clientId?: string; requestedScope?: string | null } = {},
  ) {
    const s = requireSeed()
    const origin = baseUrl
    const clientId = options.clientId ?? (await registerClient())
    const requestedScope =
      options.requestedScope === undefined
        ? "ctxpipe:read ctxpipe:write offline_access"
        : options.requestedScope

    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const authorizeUrl = new URL(
      `${baseUrl}/.auth/api/v1/auth/oauth2/authorize`,
    )
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      ...(requestedScope === null ? {} : { scope: requestedScope }),
      state: "scope-test",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${baseUrl}/mcp`,
    }).toString()
    const authorize = await app.request(authorizeUrl.toString(), {
      headers: { cookie: s.cookie, origin },
      redirect: "manual",
    })
    const location = authorize.headers.get("location")
    if (!location) {
      throw new Error(
        `authorize did not redirect: ${authorize.status} ${await authorize.text()}`,
      )
    }
    const redirectUrl = new URL(location, baseUrl)
    const consentShown = redirectUrl.pathname === "/.auth/consent"
    const consentScope = consentShown
      ? redirectUrl.searchParams.get("scope")
      : null
    let callbackUrl = redirectUrl
    if (consentShown) {
      const consent = await app.request(
        `${baseUrl}/.auth/api/v1/auth/oauth2/consent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: s.cookie,
            origin,
            "x-ctxpipe-oauth-organization": s.orgId,
          },
          body: JSON.stringify({
            accept: true,
            ...(grantedScope === null ? {} : { scope: grantedScope }),
            oauth_query: redirectUrl.search.slice(1),
          }),
        },
      )
      const consentBody = (await consent.json()) as { url?: string }
      if (!consentBody.url) {
        throw new Error(`consent failed: ${JSON.stringify(consentBody)}`)
      }
      callbackUrl = new URL(consentBody.url)
    }
    const code = callbackUrl.searchParams.get("code")
    if (!code) throw new Error(`no code: ${callbackUrl.toString()}`)

    const token = await app.request(
      `${baseUrl}/.auth/api/v1/auth/oauth2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
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
    const tokenBody = (await token.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }
    if (!tokenBody.access_token) {
      throw new Error(`token failed: ${JSON.stringify(tokenBody)}`)
    }
    return {
      accessToken: tokenBody.access_token,
      refreshToken: tokenBody.refresh_token,
      clientId,
      consentShown,
      consentScope,
      expiresIn: tokenBody.expires_in,
      scope: tokenBody.scope,
    }
  }

  /** A stored token row with these scopes. The default is a token from before the ctxpipe scopes. */
  async function storedOpaqueToken(
    scopes: string[] = ["openid", "offline_access"],
  ): Promise<string> {
    const s = requireSeed()
    const db = getSystemDb()
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, s.userId))
      .limit(1)
    if (!session) throw new Error("sign-up did not store a session")
    const clientId = `stored_${generateObjectId("oac")}`
    const token = `stored_opaque_${clientId}`
    await db.insert(oauthClients).values({
      id: generateObjectId("oac"),
      clientId,
      redirectUris: [REDIRECT_URI],
      scopes: ["openid", "profile", "email", "offline_access"],
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: s.userId,
    })
    await db.insert(oauthAccessTokens).values({
      id: generateObjectId("oat"),
      token: createHash("sha256").update(token).digest("base64url"),
      clientId,
      sessionId: session.id,
      userId: s.userId,
      referenceId: s.orgId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      scopes,
    })
    return token
  }

  function expectInsufficientScope(response: Response) {
    expect(response.status).toBe(403)
    const challenge = response.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="ctxpipe:read ctxpipe:write"')
    expect(challenge).toContain(
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    )
  }

  it("challenges a request with no credential for the read scope", async () => {
    const response = await app.request(`${baseUrl}/mcp`, { method: "POST" })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer scope="ctxpipe:read", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    )
  })

  it("puts the read scope on the challenge for a token it cannot validate", async () => {
    const response = await app.request(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-known-token" },
    })
    expect(response.status).toBe(401)
    const challenge = response.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain('error="invalid_token"')
    expect(challenge).toContain('scope="ctxpipe:read"')
  })

  it("advertises only the MCP scopes in the protected resource metadata", async () => {
    const response = await app.request(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { scopes_supported?: string[] }
    expect(body.scopes_supported).toEqual(["ctxpipe:read"])
  })

  it("issues a read-only JWT access token", async () => {
    const token = await oauthAccessToken("ctxpipe:read offline_access")
    expect(token.scope?.split(" ").sort()).toEqual([
      "ctxpipe:read",
      "offline_access",
    ])
    expect(decodeJwt(token.accessToken).scope).toBe(
      "ctxpipe:read offline_access",
    )
    const headers = { authorization: `Bearer ${token.accessToken}` }

    expect(await listToolNames(`${baseUrl}/mcp`, headers)).toEqual(READ_TOOLS)
    expectInsufficientScope(
      await callTool(`${baseUrl}/mcp`, headers, WRITE_TOOL),
    )
  })

  /** POST /workspaces is a direct-write route. A request past the write gate gets 400. */
  function createWorkspace(headers: Record<string, string>) {
    return app.request(
      `${baseUrl}/${requireSeed().orgSlug}/api/v1/workspaces`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Scope test" }),
      },
    )
  }

  it("gives only the read scope to a client that asks for read and write", async () => {
    const token = await oauthAccessToken(null)
    expect(token.consentScope).toBe("ctxpipe:read offline_access")
    expect(token.scope?.split(" ").sort()).toEqual([
      "ctxpipe:read",
      "offline_access",
    ])
    const headers = { authorization: `Bearer ${token.accessToken}` }
    expect(await listToolNames(`${baseUrl}/mcp`, headers)).toEqual(READ_TOOLS)
    const write = await createWorkspace(headers)
    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({ code: "write_grant_required" })

    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const metadata = (await (
        await app.request(`${baseUrl}${path}`)
      ).json()) as { scopes_supported?: string[] }
      expect(metadata.scopes_supported).not.toContain("ctxpipe:write")
    }
  })

  it("refuses a consent that adds the write scope", async () => {
    await expect(
      oauthAccessToken("ctxpipe:read ctxpipe:write offline_access"),
    ).rejects.toThrow(/Scope not originally requested/)
  })

  it("reads a stored grant that lists the write scope as read", async () => {
    const headers = {
      authorization: `Bearer ${await storedOpaqueToken(["openid", "ctxpipe:read", "ctxpipe:write"])}`,
    }
    expect(await listToolNames(`${baseUrl}/mcp`, headers)).toEqual(READ_TOOLS)
    expectInsufficientScope(
      await callTool(`${baseUrl}/mcp`, headers, WRITE_TOOL),
    )
    expect((await createWorkspace(headers)).status).toBe(403)
    expect(
      (await createWorkspace({ cookie: requireSeed().cookie })).status,
    ).toBe(400)
  })

  it("reads a grant from before the ctxpipe scopes as read", async () => {
    const headers = { authorization: `Bearer ${await storedOpaqueToken()}` }
    expect(await listToolNames(`${baseUrl}/mcp`, headers)).toEqual(READ_TOOLS)
    expectInsufficientScope(
      await callTool(`${baseUrl}/mcp`, headers, WRITE_TOOL),
    )
  })

  it("gives a refresh token for offline_access and keeps read only after refresh", async () => {
    const token = await oauthAccessToken("ctxpipe:read offline_access", {
      requestedScope: "ctxpipe:read offline_access",
    })
    if (!token.refreshToken) throw new Error("no refresh token was issued")

    const refresh = await app.request(
      `${baseUrl}/.auth/api/v1/auth/oauth2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: baseUrl,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refreshToken,
          client_id: token.clientId,
          resource: `${baseUrl}/mcp`,
        }).toString(),
      },
    )
    const refreshed = (await refresh.json()) as {
      access_token?: string
      scope?: string
    }
    if (!refreshed.access_token) {
      throw new Error(`refresh failed: ${JSON.stringify(refreshed)}`)
    }
    expect(refreshed.scope?.split(" ")).not.toContain("ctxpipe:write")
    const headers = { authorization: `Bearer ${refreshed.access_token}` }
    expect(await listToolNames(`${baseUrl}/mcp`, headers)).toEqual(READ_TOOLS)
    expectInsufficientScope(
      await callTool(`${baseUrl}/mcp`, headers, WRITE_TOOL),
    )
  })

  it("lists offline_access for the authorization server, not for the resource", async () => {
    const authServer = await app.request(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    )
    const authServerBody = (await authServer.json()) as {
      scopes_supported?: string[]
    }
    expect(authServerBody.scopes_supported).toContain("offline_access")

    const resource = await app.request(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    )
    const resourceBody = (await resource.json()) as {
      scopes_supported?: string[]
    }
    expect(resourceBody.scopes_supported).not.toContain("offline_access")

    const challenge = await app.request(`${baseUrl}/mcp`, { method: "POST" })
    expect(challenge.headers.get("www-authenticate")).not.toContain(
      "offline_access",
    )
  })

  it("lets a client registered before the ctxpipe scopes ask for them after the migration", async () => {
    const s = requireSeed()
    const clientId = `pre_scope_${s.userId}`
    await getSystemDb()
      .insert(oauthClients)
      .values({
        id: generateObjectId("oac"),
        clientId,
        name: "Host from before the scopes",
        redirectUris: [REDIRECT_URI],
        scopes: ["openid", "profile", "email", "offline_access"],
        tokenEndpointAuthMethod: "none",
        public: true,
        type: "native",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    await getSystemDb().execute(sql.raw(await migrationSql()))

    const [client] = await getSystemDb()
      .select({ scopes: oauthClients.scopes })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
    expect(client?.scopes).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "ctxpipe:read",
      "ctxpipe:write",
    ])

    const readOnly = await oauthAccessToken("ctxpipe:read offline_access", {
      clientId,
      requestedScope: "ctxpipe:read offline_access",
    })
    expect(readOnly.scope?.split(" ").sort()).toEqual([
      "ctxpipe:read",
      "offline_access",
    ])

    // The client may still list write, but it gets read in its place.
    const asksWrite = await oauthAccessToken(null, { clientId })
    expect(asksWrite.scope?.split(" ")).not.toContain("ctxpipe:write")
  })

  it("asks for read in place of a write-only request", async () => {
    const token = await oauthAccessToken(null, {
      requestedScope: "ctxpipe:write",
    })
    expect(token.consentScope).toBe("ctxpipe:read")
    expect(token.scope).toBe("ctxpipe:read")
  })

  it("caps a client that skips consent at read", async () => {
    const s = requireSeed()
    const clientId = `skip_consent_${s.userId}`
    await getSystemDb()
      .insert(oauthClients)
      .values({
        id: generateObjectId("oac"),
        clientId,
        name: "Trusted host",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "none",
        public: true,
        type: "native",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        skipConsent: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

    const token = await oauthAccessToken("unused", { clientId })
    expect(token.consentShown).toBe(false)
    expect(token.scope?.split(" ").sort()).toEqual([
      "ctxpipe:read",
      "offline_access",
    ])
  })

  it("reads a missing scope as read and does not ask for consent again", async () => {
    const clientId = await registerClient()
    const first = await oauthAccessToken("ctxpipe:read offline_access", {
      clientId,
      requestedScope: null,
    })
    expect(first.consentShown).toBe(true)
    expect(first.consentScope).toBe("ctxpipe:read offline_access")

    const second = await oauthAccessToken("unused", {
      clientId,
      requestedScope: null,
    })
    expect(second.consentShown).toBe(false)
    expect(second.scope?.split(" ").sort()).toEqual([
      "ctxpipe:read",
      "offline_access",
    ])
  })

  it.each([
    [
      "a personal API key",
      (s: SeededOrg) => ({ "x-api-key": s.personalApiKey }),
    ],
    [
      "a personal API key as a bearer",
      (s: SeededOrg) => ({ authorization: `Bearer ${s.personalApiKey}` }),
    ],
    ["an org API key", (s: SeededOrg) => ({ "x-api-key": s.orgApiKey })],
    ["a session cookie", (s: SeededOrg) => ({ cookie: s.cookie })],
  ])("gives %s the read scope only", async (_label, headersFor) => {
    const s = requireSeed()
    const headers = headersFor(s)
    const url = `${baseUrl}/mcp?orgSlug=${s.orgSlug}`
    expect(await listToolNames(url, headers)).toEqual(READ_TOOLS)
    expectInsufficientScope(await callTool(url, headers, WRITE_TOOL))
  })
})
