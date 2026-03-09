import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withOrgContext,
} from "../../auth/withAuth.js"
import { claimRoutes } from "./claims.js"
import { conversationRoutes } from "./conversations.js"
import { repositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  // For RPC client type inference to work, we need to chain the handlers
  // https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications
  const v1 = new OpenAPIHono<AppEnv>()
    .basePath("/:orgSlug/api/v1")
    .use("*", withCookieAuth)
    .use("*", withBearerAuth)
    .use("*", requireAuth)
    .use("*", withOrgContext)
    .route("/claims", claimRoutes)
    .route("/repositories", repositoryRoutes)
    .route("/conversations", conversationRoutes)

  app.route("/", v1)
  return v1
}
