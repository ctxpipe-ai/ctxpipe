import { OpenAPIHono } from "@hono/zod-openapi"
import { parseError } from "evlog"
import {
  type BetterAuthInstance,
  createAuthMiddleware,
} from "evlog/better-auth"
import { evlog } from "evlog/hono"
import { contextStorage, getContext } from "hono/context-storage"
import { cors } from "hono/cors"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import { requestSession } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { initDb } from "../db/client.js"
import { hostedIngestEgressEnabled } from "../domain/workspaces/ingest-sandbox-egress.js"
import { httpWideEventMessage } from "../domain/workspaces/opencode-chat-stream.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { log } from "../observability/logger.js"
import { registerAuthRoutes } from "../routes/auth.js"
import { registerMcpBrandAssetRoute } from "../routes/mcp-brand-asset.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { registerOpenapiRoutes } from "../routes/openapi.js"
import {
  registerSandboxEgressRoute,
  sandboxEgressGuard,
} from "../routes/sandbox-egress.js"
import { registerStatusRoutes } from "../routes/status"
import { registerUiRoutes } from "../routes/ui.js"
import { registerV1Routes } from "../routes/v1/index.js"
import { registerWebhookRoutes } from "../routes/webhooks.js"
import type { AppEnv } from "./env.js"
import { wwwRedirect } from "./www-redirect.js"

/**
 * Paths that must not resolve Better Auth sessions (static UI + auth/webhook).
 * Session lookup shares the backend pool; asset storms must not SELECT `sessions`.
 */
export const betterAuthIdentifyExclude = [
  "/.auth/api/v1/auth/**",
  "/.auth/api/config",
  "/.auth/api/v1/public/**",
  "/.well-known/**",
  "/.status",
  "/api/v1/webhook/**",
  "/assets/**",
  "/fonts/**",
  "/favicon.ico",
  "/@**",
] as const

export function createApp() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)

  /**
   * Evlog only: enriches `c.var.log` wide events; does not set `c.var.user` or gate routes.
   * The lookup is the request's shared one, so `withCookieAuth` does not read the session again.
   */
  const identifyBetterAuthUser = createAuthMiddleware(
    {
      api: {
        getSession: () => requestSession(getContext<AppEnv>()),
      },
    } as unknown as BetterAuthInstance,
    {
      exclude: [...betterAuthIdentifyExclude],
      maskEmail: env.NODE_ENV === "production",
    },
  )

  const app = new OpenAPIHono<AppEnv>()

  // First: a sandbox-forwarded request must not reach any other route.
  app.use("*", sandboxEgressGuard())

  // Hosted only: www.app.ctxpipe.ai redirects before auth and routing.
  app.use("*", wwwRedirect())

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
  app.use(
    evlog({
      enrich: (ctx) => {
        const message = httpWideEventMessage({
          method: ctx.event.method ?? ctx.request?.method,
          path: ctx.event.path ?? ctx.request?.path,
          status: ctx.event.status ?? ctx.response?.status,
        })
        if (message) ctx.event.message = message
      },
    }),
  )
  app.use("*", async (c, next) => {
    const requestLog = c.get("log")
    if (requestLog) {
      await identifyBetterAuthUser(requestLog, c.req.raw.headers, c.req.path)
    }
    await next()
  })
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("user", null)
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("oauthScopes", null)
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

    const requestLog = c.get("log")
    if (requestLog) {
      requestLog.error(error)
    } else {
      log.error({
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.stack : String(error),
      })
    }
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

  // Hosted ingest sandbox egress (no session auth; Vercel OIDC and a sealed scope)
  if (hostedIngestEgressEnabled()) registerSandboxEgressRoute(app)

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
