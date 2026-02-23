import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withAuth } from "../../auth/withAuth.js"
import { registerAuthRoutes } from "./auth.js"
import { registerHealthRoutes } from "./health.js"
import { registerRepositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>().basePath("/api/v1")
  v1.use("*", withAuth)

  registerHealthRoutes(v1)
  registerAuthRoutes(v1)
  registerRepositoryRoutes(v1)

  app.route("/", v1)
  return v1
}
