import { OpenAPIHono } from "@hono/zod-openapi"
import { cors } from "hono/cors"
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
    await next()
  })

  const api = new OpenAPIHono<AppEnv>()
  registerSearchRoutes(api)
  registerRepoRoutes(api)
  app.route("/", api)

  registerOpenapiRoutes(app, api)

  return app
}
