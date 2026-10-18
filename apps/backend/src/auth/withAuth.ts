import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { desc, eq } from "drizzle-orm"
import type { Context, MiddlewareHandler, Next } from "hono"
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
} from "jose"
import type { AppEnv } from "../app/env.js"
import { getSystemDb } from "../db/client.js"
import { oauthAccessTokens, sessions, users } from "../db/schema/auth.js"
import {
  applyAttribution,
  attributesForOrgApiKey,
} from "../observability/attribution.js"
import { getLogger } from "../observability/logger.js"
import { callPrincipalFromContext, resolveCallOrg } from "./call-org.js"
import { type AuthSession, type AuthUser, getAuth } from "./config.js"
import { MCP_READ_SCOPE, quoteHeaderValue } from "./mcp-scopes.js"
import {
  OAUTH_GRANT_CLAIM,
  OAUTH_ORGANIZATION_CLAIM,
} from "./oauth-organization.js"

/** Seconds — small skew between issuers, clients, and this server (Better Auth / jose guidance). */
const JWT_CLOCK_TOLERANCE_SECONDS = 60

/** JWKS is stable; refetch periodically and on verification / kid mismatch. */
const JWKS_TTL_MS = 10 * 60 * 1000

let jwksCache: { jwks: JSONWebKeySet; fetchedAt: number } | null = null

/** Test hook: clears in-memory JWKS cache between cases. */
export function resetBearerJwksCacheForTests(): void {
  jwksCache = null
}

function invalidateJwksCache(): void {
  jwksCache = null
}

function getCachedJwks(): JSONWebKeySet | null {
  if (!jwksCache) return null
  if (Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS) {
    invalidateJwksCache()
    return null
  }
  return jwksCache.jwks
}

function setJwksCache(jwks: JSONWebKeySet): void {
  jwksCache = { jwks, fetchedAt: Date.now() }
}

/** Absolute URL of RFC 9728 protected resource metadata for the MCP HTTP endpoint. */
export function mcpOAuthProtectedResourceMetadataUrl(
  authBaseUrl: string,
): string {
  const base = authBaseUrl.replace(/\/$/, "")
  return `${base}/.well-known/oauth-protected-resource/mcp`
}

function isMcpRequestPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/")
}

function wwwAuthenticateInvalidToken(
  errorDescription: string,
): Record<string, string> {
  const esc = quoteHeaderValue(errorDescription)
  return {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${esc}"`,
  }
}

function wwwAuthenticateInvalidTokenMcp(
  errorDescription: string,
  authBaseUrl: string,
): Record<string, string> {
  const esc = quoteHeaderValue(errorDescription)
  const meta = mcpOAuthProtectedResourceMetadataUrl(authBaseUrl)
  const metaEsc = quoteHeaderValue(meta)
  return {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${esc}", scope="${MCP_READ_SCOPE}", resource_metadata="${metaEsc}"`,
  }
}

/**
 * RFC 6750: when the client sent no credentials, the resource server must not put
 * `error` / `error_description` on `WWW-Authenticate`. Some OAuth/OIDC clients
 * (including remote MCP hosts) only start the authorization code flow when they
 * see a bare `Bearer` challenge plus `resource_metadata`.
 */
function wwwAuthenticateMcpDiscovery(
  authBaseUrl: string,
): Record<string, string> {
  const meta = mcpOAuthProtectedResourceMetadataUrl(authBaseUrl)
  const metaEsc = quoteHeaderValue(meta)
  return {
    "WWW-Authenticate": `Bearer scope="${MCP_READ_SCOPE}", resource_metadata="${metaEsc}"`,
  }
}

type WwwAuthMcpKind = "invalid_token" | "discovery"

function wwwAuthenticateForMcpRoute(
  c: { req: { path: string }; var: { env: AppEnv["Variables"]["env"] } },
  errorDescription: string,
  kind: WwwAuthMcpKind = "invalid_token",
): Record<string, string> {
  if (!isMcpRequestPath(c.req.path)) {
    return wwwAuthenticateInvalidToken(errorDescription)
  }
  if (kind === "discovery") {
    return wwwAuthenticateMcpDiscovery(c.var.env.AUTH_BASE_URL)
  }
  return wwwAuthenticateInvalidTokenMcp(
    errorDescription,
    c.var.env.AUTH_BASE_URL,
  )
}

export function requestHasBearerCredential(raw: Request): boolean {
  const h = raw.headers.get("authorization")
  if (!h?.startsWith("Bearer ")) return false
  return h.slice("Bearer ".length).trim().length > 0
}

function logBearerAuthFailure(
  err: unknown,
  extra: { kid?: string } = {},
): void {
  const wrapped =
    err instanceof Error ? err : new Error(String(err), { cause: err })
  getLogger().error(wrapped, {
    kid: extra.kid,
    reason: "bearer_token_validation",
  })
}

async function resolveJwks(
  auth: ReturnType<typeof getAuth>,
  authBaseUrl: string,
  forceRefresh: boolean,
): Promise<JSONWebKeySet> {
  if (!forceRefresh) {
    const cached = getCachedJwks()
    if (cached) return cached
  }

  const jwksUrl = new URL("/.auth/api/v1/auth/jwks", authBaseUrl)
  let response = await auth.handler(new Request(jwksUrl)).catch((err) => {
    getLogger().error("Error fetching JWKS", { error: err })
    return new Response(null, { status: 500 })
  })

  if (!response.ok && response.status >= 500) {
    await new Promise((r) => setTimeout(r, 50))
    response = await auth.handler(new Request(jwksUrl))
  }

  if (!response.ok) {
    throw new Error(`Unable to load JWKS: ${response.status}`)
  }

  const jwks = await response.json()
  setJwksCache(jwks)
  return jwks
}

function isLikelyJwksKeyProblem(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  if (code === "ERR_JWT_EXPIRED") return false
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") return false
  return true
}

/**
 * `@better-auth/oauth-provider` stores opaque access tokens as
 * `base64url(sha256(token))` (default `storeTokens: "hashed"`). We hash the
 * incoming bearer the same way before looking it up.
 */
function hashOpaqueAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url")
}

async function resolveBearerPrincipal(
  userId: string,
  sessionId: string | null | undefined,
): Promise<{ session: AuthSession | null; user: AuthUser } | null> {
  const db = getSystemDb()
  if (sessionId) {
    const rows = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1)
    if (rows[0]) return rows[0]
  }

  const sessionRows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(users.id, userId))
    .orderBy(desc(sessions.updatedAt))
    .limit(1)
  if (sessionRows[0]) return sessionRows[0]

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return userRows[0] ? { session: null, user: userRows[0] } : null
}

async function resolveOpaqueAccessToken(token: string): Promise<{
  session: AuthSession | null
  user: AuthUser
  oauthReferenceId: string | null
  oauthClientId: string | null
  oauthScopes: string[]
} | null> {
  const db = getSystemDb()
  const hashed = hashOpaqueAccessToken(token)
  const tokenRows = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.token, hashed))
    .limit(1)
  const record = tokenRows[0]
  if (!record || !record.userId) return null
  if (!record.expiresAt || record.expiresAt.getTime() <= Date.now()) return null

  const principal = await resolveBearerPrincipal(
    record.userId,
    record.sessionId,
  )
  return principal
    ? {
        ...principal,
        oauthReferenceId: record.referenceId ?? null,
        oauthClientId: record.clientId ?? null,
        oauthScopes: record.scopes,
      }
    : null
}

async function resolveSessionToken(
  token: string,
): Promise<{ session: AuthSession; user: AuthUser } | null> {
  const db = getSystemDb()
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.session.expiresAt && row.session.expiresAt.getTime() <= Date.now()) {
    return null
  }
  return row
}

export type RequestSession = Awaited<
  ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>
>

/**
 * The Better Auth session of the request headers. The first caller starts the
 * lookup and keeps it in `c.var`. The evlog identify middleware and
 * {@link withCookieAuth} share it, so one request reads the session one time.
 * Both callers run before a route handler, and no handler reads this value, so
 * a session change in a handler cannot see a stale value.
 */
export function requestSession(c: Context<AppEnv>): Promise<RequestSession> {
  const known = c.get("sessionLookup")
  if (known) return known
  const lookup = getAuth().api.getSession({ headers: c.req.raw.headers })
  c.set("sessionLookup", lookup)
  return lookup
}

export const withCookieAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user") || c.get("session") || c.get("orgApiKey")) return next()
  const started = performance.now()
  const apiKeyHeader = c.req.header("x-api-key")?.trim()
  let authSession: RequestSession = null
  try {
    authSession = await requestSession(c)
  } catch (err) {
    // Org keys cannot mock a user session. The user-config session hook may
    // throw when `x-api-key` is an organization key; fall through to verify.
    if (!apiKeyHeader) throw err
    authSession = null
  }
  const resolvedIn = Math.round(performance.now() - started)
  if (!authSession?.user || !authSession.session) {
    getLogger().set({ auth: { resolvedIn, identified: false } })
    if (authSession?.user && !authSession.session) {
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateForMcpRoute(c, "Session invalid or missing"),
      )
    }
    return next()
  }
  // @better-auth/api-key 1.6.23 sets this mocked session id to the key id
  // inside getSession, after validateApiKey has already counted the request.
  if (apiKeyHeader) c.set("personalApiKeyId", authSession.session.id)
  c.set("user", authSession.user)
  c.set("session", authSession.session)
  applyPrincipalAttribution(c)
  getLogger().set({
    user: { id: authSession.user.id },
    auth: { resolvedIn, identified: true },
  })
  return next()
}

function applyPrincipalAttribution(c: Context<AppEnv>): void {
  const orgApiKey = c.get("orgApiKey")
  const userId = c.get("user")?.id
  const oauthClientId = c.get("oauthClientId")
  const personalApiKeyId = c.get("personalApiKeyId")
  if (orgApiKey) {
    applyAttribution(attributesForOrgApiKey(orgApiKey))
    return
  }
  if (!userId && !oauthClientId) return
  const actorType =
    oauthClientId || c.get("oauthReferenceId") ? "oauth_client" : "user"
  applyAttribution({
    "ctxpipe.actor.type": actorType,
    ...(userId ? { "enduser.id": userId } : {}),
    ...(personalApiKeyId ? { "ctxpipe.api_key.id": personalApiKeyId } : {}),
    ...(oauthClientId ? { "ctxpipe.oauth.client_id": oauthClientId } : {}),
  })
}

type BearerApiKeyAuthResult =
  | {
      kind: "user"
      user: AuthUser
      session: AuthSession
      personalApiKeyId: string
    }
  | {
      kind: "org"
      orgApiKey: NonNullable<AppEnv["Variables"]["orgApiKey"]>
    }
  | { kind: "invalid" }

async function resolveOrgApiKey(
  apiKey: string,
): Promise<NonNullable<AppEnv["Variables"]["orgApiKey"]> | null> {
  const verified = await getAuth()
    .api.verifyApiKey({ body: { key: apiKey } })
    .catch((err: unknown) => {
      getLogger().error(
        err instanceof Error ? err : new Error(String(err), { cause: err }),
        { reason: "org_api_key_verify" },
      )
      return null
    })

  if (
    !verified?.valid ||
    !verified.key ||
    verified.key.configId !== "organization" ||
    !verified.key.referenceId
  ) {
    return null
  }

  return {
    id: verified.key.id,
    orgId: verified.key.referenceId,
    configId: verified.key.configId,
  }
}

/**
 * Personal or org API key presented as `Authorization: Bearer <key>` (MCP
 * hosts that cannot set `x-api-key`, e.g. CodeRabbit). Tries user session first
 * (`enableSessionForAPIKeys`), then org-owned verify.
 */
async function resolveBearerApiKeyAuth(
  apiKey: string,
): Promise<BearerApiKeyAuthResult> {
  const auth = getAuth()
  const apiKeyHeaders = new Headers({ "x-api-key": apiKey })

  try {
    const authSession = await auth.api.getSession({ headers: apiKeyHeaders })
    if (authSession?.user && authSession?.session) {
      return {
        kind: "user",
        user: authSession.user,
        session: authSession.session,
        personalApiKeyId: authSession.session.id,
      }
    }
  } catch {
    // Org keys cannot mock a user session; fall through to verifyApiKey.
  }

  const orgApiKey = await resolveOrgApiKey(apiKey)
  return orgApiKey ? { kind: "org", orgApiKey } : { kind: "invalid" }
}

/**
 * Verify an org-owned `x-api-key` without fabricating a user session.
 * User keys still authenticate via {@link withCookieAuth} (`getSession`).
 * Mount only on `/mcp` — REST already 401s with no user session, and verifying
 * here would count against the org key's rate limit.
 */
export const withOrgApiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user") || c.get("session") || c.get("orgApiKey")) return next()
  const apiKey = c.req.header("x-api-key")?.trim()
  if (!apiKey) return next()

  const orgApiKey = await resolveOrgApiKey(apiKey)
  if (!orgApiKey) {
    getLogger().warn("Unauthorized because of invalid API key")
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "The API key could not be validated"),
    )
  }

  c.set("orgApiKey", orgApiKey)
  applyPrincipalAttribution(c)
  return next()
}

/**
 * The grant reference of a JWT access token: the grant id claim, else the
 * legacy org id claim, else null. `false` when a claim is present but invalid.
 */
function readOAuthReferenceClaim(
  payload: Record<string, unknown>,
): string | null | false {
  for (const claim of [OAUTH_GRANT_CLAIM, OAUTH_ORGANIZATION_CLAIM]) {
    const value = payload[claim]
    if (value === undefined) continue
    return typeof value === "string" && value.length > 0 ? value : false
  }
  return null
}

async function authenticateBearer(
  c: Context<AppEnv>,
  next: Next,
  allowApiKeyFallback: boolean,
) {
  const authorization = c.req.header("authorization")
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "").trim()
    : null
  if (!accessToken) return next()

  // Better Auth's oauthProvider only issues JWT access tokens when the client
  // sends the RFC 8707 `resource` parameter (`index.mjs:411`). MCP clients like
  // CodeRabbit omit it, so we get an opaque random string instead. JWTs have
  // three `.`-separated base64url segments; anything else is opaque OAuth,
  // then a Better Auth session token, then (on MCP only) a personal/org API key.
  if (accessToken.split(".").length !== 3) {
    const opaque = await resolveOpaqueAccessToken(accessToken)
    if (opaque) {
      c.set("personalApiKeyId", null)
      c.set("session", opaque.session)
      c.set("user", opaque.user)
      c.set("oauthReferenceId", opaque.oauthReferenceId)
      c.set("oauthClientId", opaque.oauthClientId)
      c.set("oauthScopes", opaque.oauthScopes)
      applyPrincipalAttribution(c)
      return next()
    }
    const sessionResolved = await resolveSessionToken(accessToken)
    if (sessionResolved) {
      c.set("personalApiKeyId", null)
      c.set("session", sessionResolved.session)
      c.set("user", sessionResolved.user)
      applyPrincipalAttribution(c)
      return next()
    }

    if (allowApiKeyFallback) {
      const apiKeyAuth = await resolveBearerApiKeyAuth(accessToken)
      if (apiKeyAuth.kind === "user") {
        c.set("user", apiKeyAuth.user)
        c.set("session", apiKeyAuth.session)
        c.set("personalApiKeyId", apiKeyAuth.personalApiKeyId)
        applyPrincipalAttribution(c)
        return next()
      }
      if (apiKeyAuth.kind === "org") {
        c.set("personalApiKeyId", null)
        c.set("orgApiKey", apiKeyAuth.orgApiKey)
        applyPrincipalAttribution(c)
        return next()
      }
    }

    logBearerAuthFailure(new Error("Opaque access token not recognized"))
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "The access token could not be validated"),
    )
  }

  const auth = getAuth()
  const authBaseUrl = c.var.env.AUTH_BASE_URL
  const defaultAuthIssuer = new URL(
    "/.auth/api/v1/auth",
    authBaseUrl,
  ).toString()
  const allowedIssuers = c.var.env.AUTH_ISSUER
    ? [c.var.env.AUTH_ISSUER, defaultAuthIssuer]
    : [defaultAuthIssuer]
  const audience = [authBaseUrl, `${authBaseUrl}/mcp`]
  const verifyOpts = {
    issuer: allowedIssuers,
    audience,
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  }

  let tokenSessionId: string | null = null
  let kid: string | undefined
  try {
    const header = decodeProtectedHeader(accessToken)
    if (typeof header.kid === "string") kid = header.kid
  } catch {
    // ignore — jwtVerify will fail with a clear error
  }

  const [jwks, jwksErr] = await resolveJwks(auth, authBaseUrl, false)
    .then((jwks) => [jwks, undefined] as const)
    .catch((err: unknown) => [undefined, err] as const)

  if (jwksErr || !jwks) {
    logBearerAuthFailure(jwksErr, { kid })
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "The access token could not be validated"),
    )
  }

  let [payload, verifyErr] = await jwtVerify(
    accessToken,
    createLocalJWKSet(jwks),
    verifyOpts,
  )
    .then(({ payload }) => [payload, undefined] as const)
    .catch((err: unknown) => [undefined, err] as const)

  if (verifyErr) {
    const code = (verifyErr as { code?: string }).code
    if (code === "ERR_JWT_EXPIRED") {
      logBearerAuthFailure(verifyErr, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateForMcpRoute(c, "The access token expired"),
      )
    }
    if (!isLikelyJwksKeyProblem(verifyErr)) {
      logBearerAuthFailure(verifyErr, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateForMcpRoute(
          c,
          "The access token could not be validated",
        ),
      )
    }
    invalidateJwksCache()
    const [jwks2, jwks2Err] = await resolveJwks(auth, authBaseUrl, true)
      .then((jwks) => [jwks, undefined] as const)
      .catch((err: unknown) => [undefined, err] as const)
    if (jwks2Err || !jwks2) {
      logBearerAuthFailure(jwks2Err, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateForMcpRoute(
          c,
          "The access token could not be validated",
        ),
      )
    }
    ;[payload, verifyErr] = await jwtVerify(
      accessToken,
      createLocalJWKSet(jwks2),
      verifyOpts,
    )
      .then(({ payload }) => [payload, undefined] as const)
      .catch((err: unknown) => [undefined, err] as const)
    if (verifyErr) {
      logBearerAuthFailure(verifyErr, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateForMcpRoute(
          c,
          "The access token could not be validated",
        ),
      )
    }
  }

  if (!payload) {
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "The access token could not be validated"),
    )
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "The access token subject is invalid"),
    )
  }
  const oauthReferenceClaim = readOAuthReferenceClaim(payload)
  if (oauthReferenceClaim === false) {
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "The access token organization is invalid"),
    )
  }
  tokenSessionId =
    typeof payload.sid === "string" && payload.sid.length > 0
      ? payload.sid
      : null

  // offline_access refresh grants may outlive the browser session. Resolve
  // the still-active user even when the original session has been deleted.
  const tokenSessionContext = await resolveBearerPrincipal(
    payload.sub,
    tokenSessionId,
  )

  if (tokenSessionContext) {
    c.set("personalApiKeyId", null)
    c.set("session", tokenSessionContext.session)
    c.set("user", tokenSessionContext.user)
    c.set("oauthReferenceId", oauthReferenceClaim)
    c.set(
      "oauthScopes",
      typeof payload.scope === "string" ? payload.scope.split(" ") : [],
    )
    const clientIdClaim = payload.client_id ?? payload.azp
    if (typeof clientIdClaim === "string" && clientIdClaim.length > 0) {
      c.set("oauthClientId", clientIdClaim)
    }
    applyPrincipalAttribution(c)
    return next()
  }

  logBearerAuthFailure(
    new Error(
      tokenSessionId
        ? "Bearer JWT session id not found"
        : "Bearer JWT subject has no resolvable session",
    ),
    { kid },
  )
  return c.json(
    { error: "Unauthorized" },
    401,
    wwwAuthenticateForMcpRoute(c, "The access token could not be validated"),
  )
}

/** OAuth Bearer authentication shared by REST and MCP routes. */
export const withBearerAuth: MiddlewareHandler<AppEnv> = (c, next) =>
  authenticateBearer(c, next, false)

/**
 * OAuth Bearer authentication with an MCP-only API-key fallback for hosts that
 * cannot set `x-api-key`. Opaque OAuth access tokens always take precedence.
 */
export const withMcpBearerAuth: MiddlewareHandler<AppEnv> = (c, next) =>
  authenticateBearer(c, next, true)

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgApiKey = c.get("orgApiKey")
  if (orgApiKey) {
    if (!isMcpRequestPath(c.req.path)) {
      getLogger().warn("Unauthorized because org API key is MCP-only")
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateForMcpRoute(c, "Authentication required"),
      )
    }
    return next()
  }

  // A personal API key is read-only (see write-grant.ts). Outside /mcp it
  // reads; every other method gets 403 before the route.
  if (
    c.get("personalApiKeyId") &&
    !isMcpRequestPath(c.req.path) &&
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
  ) {
    return c.json(
      {
        error:
          "API keys are read-only. Sign in, or use an OAuth token with the ctxpipe:write scope.",
        code: "write_grant_required",
      },
      403,
    )
  }

  const hasValidOfflineMcpBearer =
    Boolean(c.get("user")) &&
    isMcpRequestPath(c.req.path) &&
    requestHasBearerCredential(c.req.raw)
  if (!c.get("user") || (!c.get("session") && !hasValidOfflineMcpBearer)) {
    getLogger().warn("Unauthorized because of no session")
    const mcpKind: WwwAuthMcpKind =
      isMcpRequestPath(c.req.path) && !requestHasBearerCredential(c.req.raw)
        ? "discovery"
        : "invalid_token"
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateForMcpRoute(c, "Authentication required", mcpKind),
    )
  }
  return next()
}

export async function hasOrgAdminOrOwnerRole(input: {
  headers: Headers
  orgId: string
}): Promise<boolean> {
  try {
    const result = await getAuth().api.getActiveMemberRole({
      headers: input.headers,
      query: { organizationId: input.orgId },
    })
    return result.role === "admin" || result.role === "owner"
  } catch {
    return false
  }
}

/** Use after {@link requireAuth} and {@link withNetworkOrgContext}. Requires an org admin or owner session (Better Auth organization plugin); an API key gets 403. */
export const requireOrgAdminOrOwner: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const user = c.get("user")
  const orgId = c.get("orgId")
  // Better Auth gives a personal API key a session with the user's role, so
  // the role check alone would let the key through.
  if (!user?.id || !orgId || c.get("personalApiKeyId") || c.get("orgApiKey")) {
    return c.json({ error: "Forbidden" }, 403)
  }
  if (
    await hasOrgAdminOrOwnerRole({
      headers: c.req.raw.headers,
      orgId,
    })
  ) {
    return next()
  }
  return c.json({ error: "Forbidden" }, 403)
}

export const withNetworkOrgContext: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  // REST routes take the org from the URL. `/mcp` does not use this
  // middleware: MCP read tools name the org in their `org` argument.
  const rawOrgSlug = c.req.param("orgSlug") ?? c.req.query("orgSlug")
  const result = await resolveCallOrg(callPrincipalFromContext(c), rawOrgSlug)
  if (!result.ok && result.error === "org_required") {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message:
            "Name an organization: use /mcp?orgSlug=<orgSlug>. Reconnect ctxpipe to select one organization instead.",
        },
        id: null,
      },
      400,
    )
  }
  if (!result.ok) return c.json({ error: "Not found" }, 404)
  return bindRequestOrg(c, result.org, next)
}

/**
 * Make `org` the org of the request: the Hono variables, the org context
 * for short org SQL, and the request attribution. Do not hold a request-wide
 * transaction across HTTP, MCP, or sandbox I/O — those gateways call `assertNotInOrgDbContext()`.
 */
function bindRequestOrg(c: Context<AppEnv>, org: OrgContext, next: Next) {
  c.set("orgSlug", org.slug)
  c.set("orgId", org.id)
  applyAttribution({
    "ctxpipe.org.id": org.id,
    "ctxpipe.org.slug": org.slug,
  })
  return withOrgIdContext({ id: org.id, slug: org.slug }, () => next())
}

type OrgContext = { id: string; slug: string }
export const orgIdStorage = new AsyncLocalStorage<OrgContext>()

export function withOrgIdContext<T>(
  org: OrgContext,
  handler: () => Promise<T>,
) {
  return orgIdStorage.run(org, async () => handler())
}
