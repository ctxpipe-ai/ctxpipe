import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withAuth } from "../../auth/withAuth.js"
import { authRoutes } from "./auth.js"
import { healthRoutes } from "./health.js"
import { repositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>().basePath("/api/v1")
  v1.use("*", withAuth)
  
  // For RPC client type inference to work, we need to chain the handlers
  // https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications
  const v1Routes = v1.route("/health", healthRoutes).route("/auth", authRoutes).route("/repositories", repositoryRoutes)
  
  app.route("/", v1)
  return v1Routes
}
