import type { OpenAPIHono } from "@hono/zod-openapi"
import { bodyLimit } from "hono/body-limit"
import type { AppEnv } from "../app/env.js"
import { applyAttribution } from "../observability/attribution.js"
import { registerAtlassianWebhookRoute } from "./webhooks/atlassian/atlassian.js"
import { registerGithubWebhookRoute } from "./webhooks/github/github.js"
import { registerLinearWebhookRoute } from "./webhooks/linear/linear.js"
import { registerNotionWebhookRoute } from "./webhooks/notion/notion.js"
import { registerPagerdutyWebhookRoute } from "./webhooks/pagerduty/pagerduty.js"
import { registerSlackWebhookRoute } from "./webhooks/slack/slack.js"

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>) {
  app.use("/api/v1/webhook/*", async (_c, next) => {
    applyAttribution({ "ctxpipe.actor.type": "webhook" })
    await next()
  })
  // Each route reads the whole body before it checks the connection and the
  // signature, so the limit must come first. GitHub sends up to 25 MB. The
  // other providers send small JSON events, so 1 MB is far above any real one.
  for (const [path, maxSize] of [
    ["/api/v1/webhook/github/*", 25 * 1024 * 1024],
    ["/api/v1/webhook/atlassian/*", 1024 * 1024],
    ["/api/v1/webhook/slack/*", 1024 * 1024],
    ["/api/v1/webhook/linear/*", 1024 * 1024],
    ["/api/v1/webhook/notion/*", 1024 * 1024],
    ["/api/v1/webhook/pagerduty/*", 1024 * 1024],
  ] as const) {
    app.use(
      path,
      bodyLimit({
        maxSize,
        onError: (c) => c.json({ error: "Payload too large" }, 413),
      }),
    )
  }
  registerGithubWebhookRoute(app)
  registerAtlassianWebhookRoute(app)
  registerSlackWebhookRoute(app)
  registerLinearWebhookRoute(app)
  registerNotionWebhookRoute(app)
  registerPagerdutyWebhookRoute(app)
}
