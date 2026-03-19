import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withNetworkOrgContext,
} from "../../auth/withAuth.js"
import { conversationRoutes } from "./conversations.js"
import { githubInstallationRoutes } from "./github-installation.js"
import { meGithubInstallationsRoutes } from "./me-github-installations.js"
import { repositoryRoutes } from "./repositories.js"

export function registerV1Routes(app: OpenAPIHono<AppEnv>) {
  // For RPC client type inference to work, we need to chain the handlers
  // https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications
  const orgScopedV1 = new OpenAPIHono<AppEnv>()
    .basePath("/:orgSlug/api/v1")
    .use("*", withCookieAuth)
    .use("*", withBearerAuth)
    .use("*", requireAuth)
    .use("*", withNetworkOrgContext)
    .route("/repositories", repositoryRoutes)
    .route("/conversations", conversationRoutes)
    .route("/github/installation", githubInstallationRoutes)

  const nonOrgScopedV1 = new OpenAPIHono<AppEnv>()
    .basePath("/api/v1")
    .use("*", withCookieAuth)
    .use("*", withBearerAuth)
    .use("*", requireAuth)
    .route("/me/github/installations", meGithubInstallationsRoutes)

  app.route("/", orgScopedV1)
  app.route("/", nonOrgScopedV1)
  return orgScopedV1
}
