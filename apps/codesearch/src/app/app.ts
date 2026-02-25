import { OpenAPIHono } from "@hono/zod-openapi"
import { cors } from "hono/cors"
import { verifyCodesearchJwt } from "../auth/jwt.js"
import type { Env } from "../config/env.js"
import { createDb } from "../db/client.js"
import { registerOpenapiRoutes } from "../routes/openapi.js"
import { registerRepoRoutes } from "../routes/repo.js"
import { registerSearchRoutes } from "../routes/search.js"
import type { AppEnv } from "./env.js"

export type { AppEnv } from "./env.js"

export function createApp(env: Env) {
  const app = new OpenAPIHono<AppEnv>()
  const db = env.DATABASE_URL ? createDb(env) : null

  app.use("*", cors())
  app.use("*", async (c, next) => {
    c.set("db", db)
    c.set("env", env)
    c.set("auth", null)
    await next()
  })

  const api = new OpenAPIHono<AppEnv>()
  api.use("*", async (c, next) => {
    const verified = await verifyCodesearchJwt({
      env: c.get("env"),
      authorizationHeader: c.req.header("authorization"),
    }).catch(() => null)
    if (!verified) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    c.set("auth", verified)
    await next()
  })
  registerSearchRoutes(api)
  registerRepoRoutes(api)
  app.route("/", api)

  registerOpenapiRoutes(app, api)

  return app
}
