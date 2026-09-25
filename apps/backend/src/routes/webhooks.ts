import type { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { applyAttribution } from "../observability/attribution.js"
import { getLogger } from "../observability/logger.js"
import { registerAtlassianWebhookRoute } from "./webhooks/atlassian/atlassian.js"
import { registerGithubWebhookRoute } from "./webhooks/github/github.js"
import { registerLinearWebhookRoute } from "./webhooks/linear/linear.js"
import { registerNotionWebhookRoute } from "./webhooks/notion/notion.js"
import { registerPagerdutyWebhookRoute } from "./webhooks/pagerduty/pagerduty.js"
import { registerSlackWebhookRoute } from "./webhooks/slack/slack.js"

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>) {
  app.use("/api/v1/webhook/*", async (_c, next) => {
    let requestLogger: ReturnType<typeof getLogger> | undefined
    try {
      requestLogger = getLogger()
    } catch {
      requestLogger = undefined
    }
    applyAttribution({ "ctxpipe.actor.type": "webhook" }, requestLogger)
    await next()
  })
  registerGithubWebhookRoute(app)
  registerAtlassianWebhookRoute(app)
  registerSlackWebhookRoute(app)
  registerLinearWebhookRoute(app)
  registerNotionWebhookRoute(app)
  registerPagerdutyWebhookRoute(app)
}
