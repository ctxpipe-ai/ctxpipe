import type { OpenAPIHono } from "@hono/zod-openapi"
import { Scalar } from "@scalar/hono-api-reference"
import type { AppEnv } from "../app/env.js"

export function registerOpenapiRoutes(
  app: OpenAPIHono<AppEnv>,
  api: OpenAPIHono<AppEnv>,
) {
  app.get("/openapi", (c) => {
    const spec = api.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Codesearch API", version: "0.1.0" },
      servers: [{ url: new URL(c.req.url).origin, description: "API" }],
    })
    return c.json(spec)
  })
  app.get("/doc", Scalar({ url: "/openapi", pageTitle: "Codesearch API" }))
}
