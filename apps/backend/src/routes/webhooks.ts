import type { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { registerAtlassianWebhookRoute } from "./webhooks/atlassian/atlassian.js"
import { registerGithubWebhookRoute } from "./webhooks/github/github.js"
import { registerLinearWebhookRoute } from "./webhooks/linear/linear.js"
import { registerNotionWebhookRoute } from "./webhooks/notion/notion.js"

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>) {
  registerGithubWebhookRoute(app)
  registerAtlassianWebhookRoute(app)
  registerLinearWebhookRoute(app)
  registerNotionWebhookRoute(app)
}
