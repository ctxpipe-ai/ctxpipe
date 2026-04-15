import { AsyncLocalStorage } from "node:async_hooks"
import { eq } from "drizzle-orm"
import type { RequestLogger } from "evlog"
import type { MiddlewareHandler } from "hono"
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
} from "jose"
import type { AppEnv } from "../app/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations, sessions, users } from "../db/schema/auth.js"
import { getLogger } from "../observability/logger.js"
import { getAuth } from "./config.js"

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

function wwwAuthenticateInvalidToken(
  errorDescription: string,
): Record<string, string> {
  const esc = errorDescription.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${esc}"`,
  }
}

function logBearerAuthFailure(
  log: RequestLogger,
  err: unknown,
  extra: { kid?: string } = {},
): void {
  const wrapped =
    err instanceof Error ? err : new Error(String(err), { cause: err })
  log.error(wrapped, { kid: extra.kid, reason: "bearer_token_validation" })
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

export const withCookieAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = getAuth()
  const authSession = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!authSession) return next()
  if (!authSession.user || !authSession.session) {
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateInvalidToken("Session invalid or missing"),
    )
  }

  c.set("user", authSession.user)
  c.set("session", authSession.session)
  return next()
}

export const withBearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const log = c.get("log")
  const authorization = c.req.header("authorization")
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "").trim()
    : null
  if (!accessToken) return next()

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
    logBearerAuthFailure(log, jwksErr, { kid })
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateInvalidToken("The access token could not be validated"),
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
      logBearerAuthFailure(log, verifyErr, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateInvalidToken("The access token expired"),
      )
    }
    if (!isLikelyJwksKeyProblem(verifyErr)) {
      logBearerAuthFailure(log, verifyErr, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateInvalidToken("The access token could not be validated"),
      )
    }
    invalidateJwksCache()
    const [jwks2, jwks2Err] = await resolveJwks(auth, authBaseUrl, true)
      .then((jwks) => [jwks, undefined] as const)
      .catch((err: unknown) => [undefined, err] as const)
    if (jwks2Err || !jwks2) {
      logBearerAuthFailure(log, jwks2Err, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateInvalidToken("The access token could not be validated"),
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
      logBearerAuthFailure(log, verifyErr, { kid })
      return c.json(
        { error: "Unauthorized" },
        401,
        wwwAuthenticateInvalidToken("The access token could not be validated"),
      )
    }
  }

  if (!payload) {
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateInvalidToken("The access token could not be validated"),
    )
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateInvalidToken("The access token subject is invalid"),
    )
  }
  tokenSessionId =
    typeof payload.sid === "string" && payload.sid.length > 0
      ? payload.sid
      : null

  if (!tokenSessionId) return next()

  const db = getSystemDb()
  const tokenSessionRows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, tokenSessionId))
    .limit(1)

  const tokenSessionContext = tokenSessionRows[0]
  if (tokenSessionContext) {
    c.set("session", tokenSessionContext.session)
    c.set("user", tokenSessionContext.user)
  }
  return next()
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user") || !c.get("session")) {
    c.get("log").warn("Unauthorized because of no session")
    return c.json(
      { error: "Unauthorized" },
      401,
      wwwAuthenticateInvalidToken("Authentication required"),
    )
  }
  return next()
}

/** Use after {@link requireAuth} and {@link withNetworkOrgContext}. Requires org admin or owner (Better Auth organization plugin). */
export const requireOrgAdminOrOwner: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const user = c.get("user")
  const orgId = c.get("orgId")
  if (!user?.id || !orgId) {
    return c.json({ error: "Forbidden" }, 403)
  }
  try {
    const result = await getAuth().api.getActiveMemberRole({
      headers: c.req.raw.headers,
      query: { organizationId: orgId },
    })
    const role = result.role
    if (role === "admin" || role === "owner") return next()
    return c.json({ error: "Forbidden" }, 403)
  } catch {
    return c.json({ error: "Forbidden" }, 403)
  }
}

export const withNetworkOrgContext: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const orgSlug = c.req.param("orgSlug") ?? c.req.query("orgSlug")
  if (!orgSlug) return c.json({ error: "Not found" }, 404)

  const systemDb = getSystemDb()
  const orgRows = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1)

  const org = orgRows[0]
  if (!org) return c.json({ error: "Not found" }, 404)

  c.set("orgSlug", orgSlug)
  c.set("orgId", org.id)
  return withOrgIdContext({ id: org.id, slug: orgSlug }, async () =>
    withOrgDbContext(org.id, async () => next()),
  )
}

type OrgContext = { id: string; slug: string }
export const orgIdStorage = new AsyncLocalStorage<OrgContext>()

export function withOrgIdContext<T>(
  org: OrgContext,
  handler: () => Promise<T>,
) {
  return orgIdStorage.run(org, async () => handler())
}
