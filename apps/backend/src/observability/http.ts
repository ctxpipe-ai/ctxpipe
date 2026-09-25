import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import type { Context, MiddlewareHandler } from "hono"
import {
  applyAttribution,
  contextWithAttributionBag,
  copyAttributionToSpan,
  resolveRequestId,
} from "./attribution.js"
import { logFieldsFromActiveSpan } from "./logContract.js"

const TRACER_NAME = "ctxpipe-backend"

function requestLogger(
  c: Context,
): { set(data: Record<string, unknown>): void } | undefined {
  try {
    return c.get("log") as { set(data: Record<string, unknown>): void }
  } catch {
    return undefined
  }
}

/**
 * UI catch-all proxies Vite modules and hashed assets. One server span per
 * file drowns API traces; document navigations (no static suffix) still
 * continue traceparent so a browser action can join the API span.
 */
function isProxiedUiAsset(path: string): boolean {
  if (
    path.startsWith("/@") ||
    path.startsWith("/src/") ||
    path.startsWith("/node_modules/") ||
    path.startsWith("/assets/") ||
    path.startsWith("/__vite")
  ) {
    return true
  }
  return /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|txt)$/i.test(
    path,
  )
}

export function backendOtelMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"))
    c.header("x-request-id", requestId)

    const carrier: Record<string, string> = {}
    const traceparent = c.req.header("traceparent")
    const tracestate = c.req.header("tracestate")
    const baggageHeader = c.req.header("baggage")
    if (traceparent) carrier.traceparent = traceparent
    if (tracestate) carrier.tracestate = tracestate
    if (baggageHeader) carrier.baggage = baggageHeader
    const parent = propagation.extract(context.active(), carrier)

    if (isProxiedUiAsset(c.req.path)) {
      const { context: withBag } = contextWithAttributionBag(parent)
      await context.with(withBag, async () => {
        applyAttribution({ "request.id": requestId.id }, requestLogger(c))
        await next()
      })
      c.header("x-request-id", requestId.id)
      return
    }

    const tracer = trace.getTracer(TRACER_NAME)
    const userAgent = c.req.header("user-agent")
    const span = tracer.startSpan(
      `${c.req.method} ${c.req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": c.req.method,
          "url.path": c.req.path,
          "request.id": requestId.id,
          ...(userAgent ? { "user_agent.original": userAgent } : {}),
        },
      },
      parent,
    )
    const { context: withBag } = contextWithAttributionBag(
      trace.setSpan(parent, span),
    )

    try {
      await context.with(withBag, async () => {
        try {
          applyAttribution({ "request.id": requestId.id }, requestLogger(c))
          await next()
          const route = c.req.routePath
          if (route && !route.includes("*")) {
            span.updateName(`${c.req.method} ${route}`)
            span.setAttribute("http.route", route)
          }
        } finally {
          copyAttributionToSpan(span, context.active())
          requestLogger(c)?.set(logFieldsFromActiveSpan())
        }
      })
      span.setAttribute("http.response.status_code", c.res.status)
      if (c.res.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      )
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.setAttribute("http.response.status_code", 500)
      throw error
    } finally {
      span.end()
      c.header("x-request-id", requestId.id)
    }
  }
}
