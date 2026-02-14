import type { OpenAPIHono } from "@hono/zod-openapi"
import { Scalar } from "@scalar/hono-api-reference"
import type { AppEnv } from "../app/env"

export function registerOpenapiRoutes(
  app: OpenAPIHono<AppEnv>,
  v1: OpenAPIHono<AppEnv>,
) {
  // OpenAPI spec (JSON) at /openapi and Scalar UI at /doc — no prefix
  app.get("/openapi", (c) => {
    const spec = v1.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Backend API", version: "0.1.0" },
      servers: [
        { url: `${new URL(c.req.url).origin}/v1`, description: "API v1" },
      ],
    })
    return c.json(spec)
  })
  app.get("/doc", Scalar({ url: "/openapi", pageTitle: "Backend API" }))
}
