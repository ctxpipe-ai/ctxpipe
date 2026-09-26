import { httpInstrumentationMiddleware } from "@hono/otel"
import { context, propagation, trace } from "@opentelemetry/api"
import type { Context, MiddlewareHandler } from "hono"
import { matchedRoutes } from "hono/route"
import {
  contextWithAttributionBag,
  copyAttributionToSpan,
} from "./attribution.js"
import { forceFlushOtel, isRailwayPrEnvironment } from "./otel.js"
import { redactSecretPath } from "./secretPath.js"

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Hono also matches the UI catch-all (`app.all("*")` in routes/ui.ts) on
 * every request. The route that actually responds is the first matched
 * handler that does not take `next`. That handler's path is `/*` only for
 * documents and assets. A newly registered route is ahead of the catch-all
 * and keeps a server span without a path allowlist.
 */
export function isUiProxyRequest(c: Context): boolean {
  const responder = matchedRoutes(c).find((route) => route.handler.length < 2)
  return responder?.path === "/*" || responder?.path === "*"
}

function ensureRequestId(c: Context): string {
  const incoming = c.req.header("x-request-id")?.trim()
  const id =
    incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID()
  if (c.req.header("x-request-id") !== id) {
    c.req.raw.headers.set("x-request-id", id)
  }
  c.header("x-request-id", id)
  return id
}

function urlWithoutQuery(rawUrl: string, safePath: string): string {
  try {
    return `${new URL(rawUrl).origin}${safePath}`
  } catch {
    return safePath
  }
}

export function backendOtelMiddleware(): MiddlewareHandler {
  const instrument = httpInstrumentationMiddleware({
    captureActiveRequests: false,
  })

  return async (c, next) => {
    const requestId = ensureRequestId(c)
    const extracted = propagation.extract(context.active(), c.req.header())
    const { context: traced, bag } = contextWithAttributionBag(extracted)
    bag.set("request.id", requestId)
    const uiProxy = isUiProxyRequest(c)

    await context.with(traced, async () => {
      if (uiProxy) {
        await next()
        return
      }
      await instrument(c, async () => {
        const span = trace.getActiveSpan()
        const safePath = redactSecretPath(c.req.path)
        span?.setAttribute("url.path", safePath)
        span?.setAttribute("url.full", urlWithoutQuery(c.req.url, safePath))
        span?.setAttribute("request.id", requestId)
        const userAgent = c.req.header("user-agent")
        if (userAgent) span?.setAttribute("user_agent.original", userAgent)
        try {
          await next()
        } finally {
          if (span) copyAttributionToSpan(span, context.active())
        }
      })
    })

    if (!uiProxy && isRailwayPrEnvironment()) {
      setTimeout(() => {
        void forceFlushOtel()
      }, 0)
    }
  }
}
