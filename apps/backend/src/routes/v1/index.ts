import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireAuth,
  requireOrgAdminOrOwner,
  withBearerAuth,
  withCookieAuth,
  withNetworkOrgContext,
} from "../../auth/withAuth.js"
import { atlassianOauthCallbackRoutes } from "./atlassian-oauth-callback.js"
import { conversationRoutes } from "./conversations.js"
import { orgCapabilitiesRoutes } from "./capabilities.js"
import { atlassianConnectorRoutes } from "./connectors-atlassian.js"
import { connectorsListRoutes } from "./connectors-list.js"
import { githubInstallationReadRoutes, githubInstallationRoutes } from "./github-installation.js"
import { knowledgeGraphRoutes } from "./knowledge-graph.js"
import { meGithubInstallationsRoutes } from "./me-github-installations.js"
import { orgOnboardingRoutes, userOnboardingRoutes } from "./onboarding.js"
import {
  orgAtlassianOauthAdminRoutes,
  orgAtlassianOauthReadRoutes,
} from "./org-atlassian-oauth.js"
import { repositoryRoutes } from "./repositories.js"

const githubInstallationAdminScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", githubInstallationRoutes)

const atlassianConnectorScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", atlassianConnectorRoutes)

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
    .route("/github/installation", githubInstallationReadRoutes)
    .route("/github/installation", githubInstallationAdminScoped)
    .route("/connectors/atlassian", atlassianConnectorScoped)
    .route("/org/atlassian-oauth", orgAtlassianOauthReadRoutes)
    .route("/org/atlassian-oauth", orgAtlassianOauthAdminRoutes)
    .route("/capabilities", orgCapabilitiesRoutes)
    .route("/connectors", connectorsListRoutes)
    .route("/onboarding", orgOnboardingRoutes)
    .route("/knowledge-graph", knowledgeGraphRoutes)

  const nonOrgScopedV1 = new OpenAPIHono<AppEnv>()
    .basePath("/api/v1")
    .use("*", withCookieAuth)
    .use("*", withBearerAuth)
    .use("*", requireAuth)
    .route("/integrations/atlassian", atlassianOauthCallbackRoutes)
    .route("/me/github/installations", meGithubInstallationsRoutes)
    .route("/onboarding", userOnboardingRoutes)

  app.route("/", orgScopedV1)
  app.route("/", nonOrgScopedV1)
  return orgScopedV1
}
