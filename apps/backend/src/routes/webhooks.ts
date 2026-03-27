import type { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { registerAtlassianWebhookRoute } from "./webhooks/atlassian.js"
import { registerGithubWebhookRoute } from "./webhooks/github.js"

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>) {
  registerGithubWebhookRoute(app)
  registerAtlassianWebhookRoute(app)
}
