import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withOrgContext,
} from "../../auth/withAuth.js"
import { connectorRoutes } from "./connectors.js"
import { conversationRoutes } from "./conversations.js"
import { repositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>()
  v1.use("*", withCookieAuth)
  v1.use("*", withBearerAuth)
  v1.use("*", requireAuth)
  v1.use("*", withOrgContext)
  v1.route("/connectors", connectorRoutes)
  v1.route("/repositories", repositoryRoutes)
  v1.route("/conversations", conversationRoutes)

  // Mount at the full path so v1 remains a proper OpenAPIHono instance
  // (basePath() returns a plain Hono, losing getOpenAPI31Document)
  app.route("/:orgSlug/api/v1", v1)
  return v1
}
