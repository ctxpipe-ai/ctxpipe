import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context, MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  INGEST_EGRESS_PATH,
  ingestEgressProxy,
} from "../domain/workspaces/ingest-egress-proxy.js"
import { hostedIngestEgressEnabled } from "../domain/workspaces/ingest-sandbox-egress.js"
import { vercelCredentials } from "../domain/workspaces/vercel-sandbox-provider.js"
import { log } from "../observability/logger.js"

const forbidden = () => new Response("Forbidden", { status: 403 })

/**
 * Register it before each other middleware and route. A request that the
 * Vercel firewall forwards carries the sandbox's own headers (for example
 * `Authorization` or `x-api-key`). The runtime resolves dot segments in the
 * URL before routing, so such a request could leave the egress path and
 * reach another route. This refuses each request with a sandbox proxy
 * header outside the egress path. When the egress route is not mounted, it
 * refuses each such request, so none falls through to the UI catch-all.
 * The URL parser has already resolved dot segments, so the path check sees
 * the path that the router uses.
 */
export function sandboxEgressGuard(
  mounted: () => boolean = hostedIngestEgressEnabled,
): MiddlewareHandler {
  return async (c, next) => {
    const headers = c.req.raw.headers
    const fromSandbox =
      headers.has("vercel-sandbox-oidc-token") ||
      [...headers.keys()].some((name) => name.startsWith("vercel-forwarded-"))
    if (fromSandbox) {
      const { pathname } = new URL(c.req.raw.url)
      if (!mounted() || !pathname.startsWith(`${INGEST_EGRESS_PATH}/`)) {
        log.warn({
          step: "ingest-egress-refused",
          message: "A sandbox-forwarded request is outside the egress path",
        })
        return forbidden()
      }
    }
    return next()
  }
}

/**
 * The egress proxy of hosted ingest sandboxes (see `ingestEgressProxy`). No
 * session auth: the Vercel OIDC token and the sealed scope authorize each
 * request. The OIDC audience is the public forward URL, so the request URL
 * gets the public origin (`AUTH_BASE_URL`) here: behind the platform's TLS
 * proxy, the server sees plain HTTP. Each error gets a fixed 403 body.
 */
export function registerSandboxEgressRoute(app: OpenAPIHono<AppEnv>) {
  const handle = async (c: Context<AppEnv>) => {
    try {
      const request = c.req.raw
      const url = new URL(request.url)
      const publicUrl = `${new URL(c.var.env.AUTH_BASE_URL).origin}${url.pathname}${url.search}`
      return await ingestEgressProxy({
        request: new Request(publicUrl, {
          method: request.method,
          headers: [...request.headers],
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: request.body, duplex: "half" }),
        } as RequestInit),
        sealed: c.req.param("sealed") ?? "",
        secret: c.var.env.AUTH_SECRET,
        vercel: () => vercelCredentials(),
      })
    } catch (error) {
      log.error({
        step: "ingest-egress-error",
        message: `The ingest egress proxy failed: ${String(error)}`,
      })
      return forbidden()
    }
  }
  app.all(`${INGEST_EGRESS_PATH}/:sealed`, handle)
  app.all(`${INGEST_EGRESS_PATH}/:sealed/*`, handle)
}
