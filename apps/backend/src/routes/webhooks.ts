import type { OpenAPIHono } from "@hono/zod-openapi"
import { bodyLimit } from "hono/body-limit"

import type { AppEnv } from "../app/env.js"
import { applyAttribution } from "../observability/attribution.js"
import { registerAtlassianWebhookRoute } from "./webhooks/atlassian/atlassian.js"
import { registerBuildkiteWebhookRoute } from "./webhooks/buildkite/buildkite.js"
import { registerGithubWebhookRoute } from "./webhooks/github/github.js"
import { registerLinearWebhookRoute } from "./webhooks/linear/linear.js"
import { registerNotionWebhookRoute } from "./webhooks/notion/notion.js"
import { registerPagerdutyWebhookRoute } from "./webhooks/pagerduty/pagerduty.js"
import { registerPlainWebhookRoute } from "./webhooks/plain/plain.js"
import { registerSlackWebhookRoute } from "./webhooks/slack/slack.js"
import { registerZendeskWebhookRoute } from "./webhooks/zendesk/zendesk.js"

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>) {
  app.use("/api/v1/webhook/*", async (_c, next) => {
    applyAttribution({ "ctxpipe.actor.type": "webhook" })
    await next()
  })
  // Reject a body above the limit of its provider with 413 before the
  // handler reads it. With `Content-Length`, the check reads no body; a
  // chunked body stops when it passes the limit. The handler gets the same
  // raw bytes, so a signature check still works. `/x/*` also matches `/x`.
  // Each limit is above the largest real payload of that provider.
  const MiB = 1024 * 1024
  for (const [path, maxSize] of [
    // GitHub caps a payload at 25 MB ("Webhook events and payloads").
    ["/api/v1/webhook/github/*", 25 * MiB],
    // Linear sends the full changed entity (a long issue text) with no maximum.
    ["/api/v1/webhook/linear/*", 5 * MiB],
    // One Events API envelope holds one event of at most 40,000 characters.
    ["/api/v1/webhook/slack/*", 1 * MiB],
    // A Notion event holds ids and property names, not page content.
    ["/api/v1/webhook/notion/*", 1 * MiB],
    // A PagerDuty V3 event holds one incident summary.
    ["/api/v1/webhook/pagerduty/*", 1 * MiB],
    // A Buildkite build event holds the build and all its jobs, with no
    // stated maximum.
    ["/api/v1/webhook/buildkite/*", 5 * MiB],
    // A Plain timeline event can hold a long email, and the route reads none
    // of it.
    ["/api/v1/webhook/plain/*", 5 * MiB],
    // A Zendesk article event holds ids and names, not the article body.
    ["/api/v1/webhook/zendesk/*", 1 * MiB],
    // Forge reads only the event envelope; token refresh reads only headers.
    ["/api/v1/webhook/atlassian/*", 1 * MiB],
  ] as const)
    app.use(
      path,
      bodyLimit({
        maxSize,
        onError: (c) => c.json({ error: "Payload too large" }, 413),
      }),
    )
  registerGithubWebhookRoute(app)
  registerAtlassianWebhookRoute(app)
  registerSlackWebhookRoute(app)
  registerLinearWebhookRoute(app)
  registerNotionWebhookRoute(app)
  registerPagerdutyWebhookRoute(app)
  registerBuildkiteWebhookRoute(app)
  registerPlainWebhookRoute(app)
  registerZendeskWebhookRoute(app)
}
