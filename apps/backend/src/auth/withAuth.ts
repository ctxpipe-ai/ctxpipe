import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose"
import { eq } from "drizzle-orm"
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { organizations, sessions, users } from "../db/schema/auth.js"
import { withDbContext } from "../db/client.js"
import { createBetterAuth } from "./config.js"

export const withAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgSlug = c.req.param("orgSlug") ?? c.req.query("orgSlug")
  if (!orgSlug) return c.json({ error: "Not found" }, 404)

  const auth = createBetterAuth()
  const authSession = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  const authorization = c.req.header("authorization")
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "").trim()
    : null
  let hasValidAccessToken = false
  let tokenSessionId: string | null = null

  if (accessToken) {
    try {
      const defaultAuthIssuer = new URL(
        "/.auth/api/v1/auth",
        c.var.env.AUTH_BASE_URL,
      ).toString()
      const allowedIssuers = c.var.env.AUTH_ISSUER
        ? [c.var.env.AUTH_ISSUER, defaultAuthIssuer]
        : [defaultAuthIssuer]
      const jwksResponse = await auth.handler(
        new Request(
          new URL("/.auth/api/v1/auth/jwks", c.var.env.AUTH_BASE_URL),
        ),
      )
      if (!jwksResponse.ok) {
        throw new Error(`Unable to load JWKS: ${jwksResponse.status}`)
      }
      const jwks = (await jwksResponse.json()) as JSONWebKeySet
      const { payload } = await jwtVerify(
        accessToken,
        createLocalJWKSet(jwks),
        {
          issuer: allowedIssuers,
          audience: [c.var.env.AUTH_BASE_URL, `${c.var.env.AUTH_BASE_URL}/mcp`],
        },
      )
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return c.json({ error: "Unauthorized" }, 401)
      }
      hasValidAccessToken = true
      tokenSessionId =
        typeof payload.sid === "string" && payload.sid.length > 0
          ? payload.sid
          : null
    } catch (error) {
      console.error("Unauthorized because of error", accessToken, error)
      return c.json({ error: "Unauthorized" }, 401)
    }
  }
  if (!authSession && !hasValidAccessToken) {
    console.error("Unauthorized because of no session")
    return c.json({ error: "Unauthorized" }, 401)
  }
  return withDbContext(async (db) => {
    let resolvedUser = authSession?.user ?? null
    let resolvedSession = authSession?.session ?? null

    if ((!resolvedUser || !resolvedSession) && tokenSessionId) {
      const tokenSessionRows = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.id, tokenSessionId))
        .limit(1)
      const tokenSessionContext = tokenSessionRows[0]
      if (tokenSessionContext) {
        resolvedSession = tokenSessionContext.session
        resolvedUser = tokenSessionContext.user
      }
    }

    if (!resolvedUser || !resolvedSession) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    c.set("user", resolvedUser)
    c.set("session", resolvedSession)

    const orgRows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1)

    const org = orgRows[0]
    if (!org) {
      return c.json({ error: "Not found" }, 404)
    }
    c.set("orgSlug", orgSlug)
    c.set("orgId", org.id)
    return next()
  })
}
