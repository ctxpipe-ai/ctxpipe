import { OpenAPIHono } from "@hono/zod-openapi"
import { parseError } from "evlog"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
import { cors } from "hono/cors"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { parseEnv } from "../config/env.js"
import { initDb } from "../db/client.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { log } from "../observability/logger.js"
import { registerAuthRoutes } from "../routes/auth.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { registerMcpBrandAssetRoute } from "../routes/mcp-brand-asset.js"
import { registerOpenapiRoutes } from "../routes/openapi.js"
import { registerStatusRoutes } from "../routes/status"
import { registerUiRoutes } from "../routes/ui.js"
import { registerV1Routes } from "../routes/v1/index.js"
import { registerWebhookRoutes } from "../routes/webhooks.js"
import { backfillGithubAppSecretsFromEnv } from "../scripts/backfillGithubConnectionSecrets.js"
import type { AppEnv } from "./env.js"

export type { AppEnv } from "./env.js"

export function createApp() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)
  void backfillGithubAppSecretsFromEnv(env).catch((err: unknown) => {
    log.error(err instanceof Error ? err : new Error(String(err)), {
      step: "backfill.github_connection_secrets",
    })
  })

  const app = new OpenAPIHono<AppEnv>()

  const corsOrigins = (env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  app.use(
    "*",
    cors({
      origin: corsOrigins.length > 0 ? corsOrigins : "*",
      credentials: true,
    }),
  )
  app.use(contextStorage())
  app.use("*", backendOtelMiddleware())
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("user", null)
    c.set("session", null)
    c.set("oauthOrganizationId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })

  app.onError((error, c) => {
    // Dev: UI is proxied to Vite; clients often abort in-flight module/CSS streams
    // (navigation, HMR, duplicate requests). Those must not become JSON 500 bodies.
    const isAbort =
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    if (isAbort) {
      return new Response(null, { status: 499 })
    }

    c.get("log").error(error)
    const parsed = parseError(error)

    return c.json(
      {
        message: parsed.message,
        why: parsed.why,
        fix: parsed.fix,
        link: parsed.link,
      },
      parsed.status as ContentfulStatusCode,
    )
  })

  // auth
  registerAuthRoutes(app)

  // GitHub App webhooks (no session auth; HMAC verified)
  registerWebhookRoutes(app)

  // /:orgSlug/api/v1 routes
  const v1 = registerV1Routes(app)

  // /.docs/openapi and /.docs/api-reference
  registerOpenapiRoutes(app, v1 as OpenAPIHono<AppEnv>)
  // /.status
  registerStatusRoutes(app)
  // Public MCP brand asset (before /mcp; no auth)
  registerMcpBrandAssetRoute(app)
  // /mcp
  registerMcpRoutes(app)
  // UI routes - all unmatched routes are proxied to the UI
  registerUiRoutes(app, env)

  return app
}
