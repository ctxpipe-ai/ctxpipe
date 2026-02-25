import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { withDbContext } from "../db/client.js"
import { getAuth } from "./config.js"

export const withAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = getAuth()
  const authSession = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  if (!authSession) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  c.set("user", authSession.user)
  c.set("session", authSession.session)

  const orgSlug = c.req.param("orgSlug")
  if (!orgSlug) {
    return c.json({ error: "Not found" }, 404)
  }

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
    await next()
    return
  }
  return withDbContext(async () => {
    await next()
  })
}
