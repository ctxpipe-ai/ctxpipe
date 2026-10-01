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
import { orgCapabilitiesRoutes } from "./capabilities.js"
import { atlassianConnectorRoutes } from "./connectors-atlassian.js"
import {
  linearConnectorRoutes,
  linearOauthCallbackRoutes,
} from "./connectors-linear.js"
import { connectorsListRoutes } from "./connectors-list.js"
import {
  notionConnectorRoutes,
  notionOAuthCallbackRoutes,
  notionOauthAppReadRoutes,
} from "./connectors-notion.js"
import {
  pagerdutyConnectorRoutes,
  pagerdutyOauthCallbackRoutes,
} from "./connectors-pagerduty.js"
import {
  slackConnectorRoutes,
  slackOAuthCallbackRoutes,
} from "./connectors-slack.js"
import { conversationRoutes } from "./conversations.js"
import {
  githubInstallationReadRoutes,
  githubInstallationRoutes,
} from "./github-installation.js"
import { githubPrMirrorRoutes } from "./github-pr-mirror.js"
import { meGithubInstallationsRoutes } from "./me-github-installations.js"
import { orgOnboardingRoutes, userOnboardingRoutes } from "./onboarding.js"
import { openaiRoutes } from "./openai.js"
import {
  orgAtlassianOauthAdminRoutes,
  orgAtlassianOauthReadRoutes,
} from "./org-atlassian-oauth.js"
import { pendingAtlassianClaimRoutes } from "./pending-atlassian-claim.js"
import { repositoryRoutes } from "./repositories.js"
import { workspaceChatOpenaiRoutes } from "./workspace-chat-openai.js"
import { workspaceRoutes } from "./workspaces.js"

const githubInstallationAdminScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", githubInstallationRoutes)

const githubPrMirrorAdminScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", githubPrMirrorRoutes)

const atlassianConnectorScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", atlassianConnectorRoutes)

const slackConnectorScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", slackConnectorRoutes)

const linearConnectorScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", linearConnectorRoutes)

const notionConnectorScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", notionConnectorRoutes)

const pagerdutyConnectorScoped = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", pagerdutyConnectorRoutes)

function createOrgScopedV1<BasePath extends string>(
  app: OpenAPIHono<AppEnv, Record<never, never>, BasePath>,
) {
  // Incremental `.route()` after `basePath` is what `hc` can infer.
  // https://hono.dev/docs/guides/rpc#using-rpc-with-larger-applications
  return app
    .use("*", withCookieAuth)
    .use("*", withBearerAuth)
    .use("*", requireAuth)
    .use("*", withNetworkOrgContext)
    .route("/repositories", repositoryRoutes)
    .route("/workspaces", workspaceRoutes)
    .route("/conversations", conversationRoutes)
    .route("/github/installation", githubInstallationReadRoutes)
    .route("/github/installation", githubInstallationAdminScoped)
    .route("/github/pull-request-mirror", githubPrMirrorAdminScoped)
    .route("/connectors/atlassian", atlassianConnectorScoped)
    .route("/connectors/linear", linearConnectorScoped)
    .route("/connectors/notion", notionOauthAppReadRoutes)
    .route("/connectors/notion", notionConnectorScoped)
    .route("/connectors/pagerduty", pagerdutyConnectorScoped)
    .route("/connectors/atlassian/pending-claim", pendingAtlassianClaimRoutes)
    .route("/connectors/slack", slackConnectorScoped)
    .route("/org/atlassian-oauth", orgAtlassianOauthReadRoutes)
    .route("/org/atlassian-oauth", orgAtlassianOauthAdminRoutes)
    .route("/capabilities", orgCapabilitiesRoutes)
    .route("/connectors", connectorsListRoutes)
    .route("/onboarding", orgOnboardingRoutes)
    .route("/openai", openaiRoutes)
}

/** UI `hc` surface: `client[":orgSlug"].api.v1.…` */
export type OrgScopedV1Rpc = ReturnType<
  typeof createOrgScopedV1<"/:orgSlug/api/v1">
>

export function registerV1Routes(app: OpenAPIHono<AppEnv>): OrgScopedV1Rpc {
  const orgScopedV1 = createOrgScopedV1(new OpenAPIHono<AppEnv>())

  // Do not chain `.use()` after `OpenAPIHono.basePath()` — that returns a
  // plain Hono with no `getOpenAPI31Document`. One-shot
  // `.basePath().route("/", inner)` also drops RPC inference (`hc` → unknown).
  const orgScopedMounted = new OpenAPIHono<AppEnv>()
    .basePath("/:orgSlug/api/v1")
    .route("/", orgScopedV1)

  const workspaceChatOpenai = new OpenAPIHono<AppEnv>()
    .basePath("/:orgSlug/api/v1/workspace-chat/openai")
    .route("/", workspaceChatOpenaiRoutes)

  const nonOrgScopedV1 = new OpenAPIHono<AppEnv>()
    .basePath("/api/v1")
    .use("*", withCookieAuth)
    .use("*", withBearerAuth)
    .use("*", requireAuth)
    .route("/integrations/atlassian", atlassianOauthCallbackRoutes)
    .route("/connectors/slack", slackOAuthCallbackRoutes)
    .route("/integrations/linear", linearOauthCallbackRoutes)
    .route("/integrations/pagerduty", pagerdutyOauthCallbackRoutes)
    .route("/me/github/installations", meGithubInstallationsRoutes)
    .route("/connectors/notion", notionOAuthCallbackRoutes)
    .route("/onboarding", userOnboardingRoutes)

  app.route("/", workspaceChatOpenai)
  app.route("/", orgScopedMounted)
  app.route("/", nonOrgScopedV1)
  return orgScopedMounted as unknown as OrgScopedV1Rpc
}
