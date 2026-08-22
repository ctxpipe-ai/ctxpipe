import { OpenAPIHono } from "@hono/zod-openapi"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
import { cors } from "hono/cors"
import { verifyCodesearchJwt } from "../auth/jwt.js"
import type { Env } from "../config/env.js"
import { createDb } from "../db/client.js"
import { httpWideEventMessage } from "../observability/http-wide-event-message.js"
import { createEvlogDrain } from "../observability/logger.js"
import { registerGraphRoutes } from "../routes/graph.js"
import { registerOpenapiRoutes } from "../routes/openapi.js"
import { registerRepoRoutes } from "../routes/repo.js"
import { registerSearchRoutes } from "../routes/search.js"
import { registerStructuralSearchRoutes } from "../routes/structuralSearch.js"
import type { AppEnv } from "./env.js"

export type { AppEnv } from "./env.js"

export function createApp(env: Env) {
  const app = new OpenAPIHono<AppEnv>()
  const db = env.DATABASE_URL ? createDb(env) : null

  app.use("*", cors())
  app.use(contextStorage())
  app.use(
    evlog({
      drain: createEvlogDrain(),
      enrich: (ctx) => {
        const message = httpWideEventMessage({
          method: ctx.event.method ?? ctx.request?.method,
          path: ctx.event.path ?? ctx.request?.path,
          status: ctx.event.status ?? ctx.response?.status,
        })
        if (message) ctx.event.message = message
      },
    }),
  )
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
  registerGraphRoutes(api)
  registerStructuralSearchRoutes(api)
  app.route("/", api)

  registerOpenapiRoutes(app, api)

  return app
}
