import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withOrgContext,
} from "../../auth/withAuth.js"
import { repositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  // For RPC client type inference to work, we need to chain the handlers
  // https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications
  const v1 = new OpenAPIHono<AppEnv>().basePath("/:orgSlug/api/v1")
  v1.use("*", withCookieAuth)
  v1.use("*", withBearerAuth)
  v1.use("*", requireAuth)
  v1.use("*", withOrgContext)
  v1.route("/repositories", repositoryRoutes)

  app.route("/", v1)
  return v1
}
