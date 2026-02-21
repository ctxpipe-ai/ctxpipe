import { OpenAPIHono } from "@hono/zod-openapi"
import { cors } from "hono/cors"
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
  const app = new OpenAPIHono<AppEnv>()

  app.use("*", cors())
  app.use("*", async (c, next) => {
    c.set("env", env)
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

  // /openapi and /doc
  registerOpenapiRoutes(app, v1)
  // /langsmith mounted only when ENABLE_LANGSMITH=true
  registerLangsmithRoutes(app)
  // /mcp
  registerMcpRoutes(app)

  return app
}
