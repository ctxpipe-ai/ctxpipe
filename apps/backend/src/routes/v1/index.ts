import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { registerHealthRoutes } from "./health.js"
import { registerRepositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>().basePath("/v1")

  registerHealthRoutes(v1)
  registerRepositoryRoutes(v1)

  app.route("/", v1)
  return v1
}
