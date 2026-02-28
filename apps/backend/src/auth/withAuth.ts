import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { createAuthClient } from "better-auth/client"
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { withDbContext } from "../db/client.js"
import { getOAuthValidAudiences } from "./audiences.js"
import { getAuth } from "./config.js"

export const withAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = getAuth()
  const orgSlug = c.req.param("orgSlug")
  if (!orgSlug) return c.json({ error: "Not found" }, 404)

  const authSession = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  const authorization = c.req.header("authorization")
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "").trim()
    : null
  if (accessToken) {
    const issuer = c.var.env.AUTH_ISSUER ?? c.var.env.AUTH_BASE_URL
    const validAudiences = getOAuthValidAudiences(c.var.env.AUTH_BASE_URL)
    console.log("validAudiences in withAuth", validAudiences)
    const serverClient = createAuthClient({
      plugins: [oauthProviderResourceClient(auth)],
    })
    try {
      const payload = await serverClient.verifyAccessToken(accessToken, {
        verifyOptions: {
          issuer,
          audience: validAudiences,
        },
      })
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return c.json({ error: "Unauthorized" }, 401)
      }
    } catch {
      return c.json({ error: "Unauthorized" }, 401)
    }
  }
  if (!authSession) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  c.set("user", authSession.user)
  c.set("session", authSession.session)

  const organizations = await auth.api.listOrganizations({
    headers: c.req.raw.headers,
  })
  const organization = organizations.find((item) => item.slug === orgSlug)
  if (!organization) {
    return c.json({ error: "Not found" }, 404)
  }
  c.set("orgSlug", orgSlug)
  c.set("orgId", organization.id)

  if (!c.var.env.DATABASE_URL) {
    return next()
  }

  return withDbContext(async () => next())
}
