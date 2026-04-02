import { eq } from "drizzle-orm"
import type { MiddlewareHandler } from "hono"
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose"
import { AsyncLocalStorage } from "node:async_hooks"
import type { AppEnv } from "../app/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations, sessions, users } from "../db/schema/auth.js"
import { getAuth } from "./config.js"

export const withCookieAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = getAuth()
  const authSession = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!authSession) return next()
  if (!authSession.user || !authSession.session) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  c.set("user", authSession.user)
  c.set("session", authSession.session)
  return next()
}

export const withBearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authorization = c.req.header("authorization")
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "").trim()
    : null
  if (!accessToken) return next()

  const auth = getAuth()
  let tokenSessionId: string | null = null
  try {
    const defaultAuthIssuer = new URL(
      "/.auth/api/v1/auth",
      c.var.env.AUTH_BASE_URL,
    ).toString()
    const allowedIssuers = c.var.env.AUTH_ISSUER
      ? [c.var.env.AUTH_ISSUER, defaultAuthIssuer]
      : [defaultAuthIssuer]
    const jwksResponse = await auth.handler(
      new Request(new URL("/.auth/api/v1/auth/jwks", c.var.env.AUTH_BASE_URL)),
    )
    if (!jwksResponse.ok) {
      throw new Error(`Unable to load JWKS: ${jwksResponse.status}`)
    }
    const jwks = (await jwksResponse.json()) as JSONWebKeySet
    const { payload } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
      issuer: allowedIssuers,
      audience: [c.var.env.AUTH_BASE_URL, `${c.var.env.AUTH_BASE_URL}/mcp`],
    })
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    tokenSessionId =
      typeof payload.sid === "string" && payload.sid.length > 0
        ? payload.sid
        : null
  } catch (error) {
    console.error("Unauthorized because of error", accessToken, error)
    return c.json({ error: "Unauthorized" }, 401)
  }

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
    console.error("Unauthorized because of no session")
    return c.json({ error: "Unauthorized" }, 401)
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
