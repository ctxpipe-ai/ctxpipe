import { OpenAPIHono } from "@hono/zod-openapi"
import { contextStorage } from "hono/context-storage"
import { cors } from "hono/cors"
import { proxy } from "hono/proxy"
import { getAuth } from "../auth/config.js"
import { parseEnv } from "../config/env.js"
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
    await next()
  })

  startCodeIngestionWorker()

  // /api/v1 routes
  const v1 = registerV1Routes(app)

  // auth
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

  // /api/openapi and /api/doc
  registerOpenapiRoutes(app, v1)
  // /langsmith mounted only when ENABLE_LANGSMITH=true
  registerLangsmithRoutes(app)
  // /mcp
  registerMcpRoutes(app)
  // UI routes - all unmatched routes are proxied to the UI
  app.all("*", async (c) => {
    const requestUrl = new URL(c.req.url)
    const upstreamUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      env.UI_PROXY_URL,
    )
    return proxy(new Request(upstreamUrl, c.req.raw))
  })

  return app
}
