import type { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { applyAttribution } from "../observability/attribution.js"
import { registerAtlassianWebhookRoute } from "./webhooks/atlassian/atlassian.js"
import { registerGithubWebhookRoute } from "./webhooks/github/github.js"
import { registerLinearWebhookRoute } from "./webhooks/linear/linear.js"
import { registerNotionWebhookRoute } from "./webhooks/notion/notion.js"
import { registerPagerdutyWebhookRoute } from "./webhooks/pagerduty/pagerduty.js"
import { registerSlackWebhookRoute } from "./webhooks/slack/slack.js"

/**
 * One webhook can match several connections. Org and connection are set on
 * the request span only when every row shares them. Each enqueued job carries
 * its own. Actor type is set once by the webhook middleware.
 */
export function noteResolvedWebhookConnections(
  rows: { orgId: string; id: string }[],
): void {
  const orgIds = [...new Set(rows.map((row) => row.orgId).filter(Boolean))]
  if (orgIds.length !== 1) return
  const connectionIds = [...new Set(rows.map((row) => row.id).filter(Boolean))]
  const orgId = orgIds[0]
  if (!orgId) return
  const connectionId = connectionIds.length === 1 ? connectionIds[0] : undefined
  applyAttribution({
    "ctxpipe.org.id": orgId,
    ...(connectionId ? { "ctxpipe.connection.id": connectionId } : {}),
  })
}

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>) {
  app.use("/api/v1/webhook/*", async (_c, next) => {
    applyAttribution({ "ctxpipe.actor.type": "webhook" })
    await next()
  })
  registerGithubWebhookRoute(app)
  registerAtlassianWebhookRoute(app)
  registerSlackWebhookRoute(app)
  registerLinearWebhookRoute(app)
  registerNotionWebhookRoute(app)
  registerPagerdutyWebhookRoute(app)
}
