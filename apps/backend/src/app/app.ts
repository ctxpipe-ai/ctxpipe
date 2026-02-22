import { OpenAPIHono } from "@hono/zod-openapi"
import { cors } from "hono/cors"
import { contextStorage } from "hono/context-storage"
import { getAuth } from "../auth/config.js"
import { parseEnv } from "../config/env.js"
import { withDbContext } from "../db/client.js"
import { startCodeIngestionWorker } from "../domain/codeIngestion/worker.js"
import { registerLangsmithRoutes } from "../routes/langsmith.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { registerOpenapiRoutes } from "../routes/openapi.js"
import { registerV1Routes } from "../routes/v1/index.js"
import type { AppEnv } from "./env.js"

export type { AppEnv } from "./env.js"

export function createApp() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const auth = getAuth(env)
  const app = new OpenAPIHono<AppEnv>()

  const corsOrigins = (env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  app.use(
    "*",
    cors({
      origin: corsOrigins.length > 0 ? corsOrigins : "*",
      credentials: true,
    }),
  )
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("user", null)
    c.set("session", null)

    const authSession = await auth.api.getSession({
      headers: c.req.raw.headers,
    })
    if (!authSession) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    c.set("user", authSession.user)
    c.set("session", authSession.session)

    if (!env.DATABASE_URL) {
      await next()
      return
    }
    await withDbContext(async () => {
      await next()
    })
  })

  startCodeIngestionWorker()

  // /v1 routes
  const v1 = registerV1Routes(app)

  if (auth) {
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  }

  // /openapi and /doc
  registerOpenapiRoutes(app, v1)
  // /langsmith mounted only when ENABLE_LANGSMITH=true
  registerLangsmithRoutes(app)
  // /mcp
  registerMcpRoutes(app)

  return app
}
