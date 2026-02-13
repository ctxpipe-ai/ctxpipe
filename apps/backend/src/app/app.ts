import { cors } from "hono/cors"
import { OpenAPIHono } from "@hono/zod-openapi"
import { Scalar } from "@scalar/hono-api-reference"
import { createMcpRouter } from "../mcp/router.js"
import { registerRoutes } from "../routes/index.js"
import type { AppEnv } from "./env.js"

export type { AppEnv } from "./env.js"

export function createApp() {
  const app = new OpenAPIHono<AppEnv>()

  app.use("*", cors())

  // API v1 (OpenAPI + Zod validation) under /v1
  const v1 = new OpenAPIHono<AppEnv>()
  registerRoutes(v1)
  app.route("/v1", v1)

  // OpenAPI spec (JSON) at /openapi and Scalar UI at /doc — no prefix
  app.get("/openapi", (c) => {
    const spec = v1.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Backend API", version: "0.1.0" },
      servers: [{ url: new URL(c.req.url).origin + "/v1", description: "API v1" }],
    })
    return c.json(spec)
  })
  app.get("/doc", Scalar({ url: "/openapi", pageTitle: "Backend API" }))

  // MCP at /mcp (no versioning)
  const mountMcp = createMcpRouter()
  mountMcp(app)

  return app
}
