import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { withDbContext } from "../db/client.js"
import { getAuth } from "./config.js"

export const withAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = getAuth(c.var.env)
  const authSession = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  if (!authSession) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  c.set("user", authSession.user)
  c.set("session", authSession.session)

  if (!c.var.env.DATABASE_URL) {
    await next()
    return
  }
  return withDbContext(async () => {
    await next()
  })
}
