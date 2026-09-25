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
  stripUntrustedAttributionBaggage,
} from "./attribution.js"
import { logFieldsFromActiveSpan } from "./logContract.js"
import { redactSecretPath } from "./secretPath.js"

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

/** Backend routes that must keep a server span, including wildcard mounts. */
function isBackendSpanPath(path: string): boolean {
  return (
    path.startsWith("/.auth/api") ||
    path.startsWith("/.otel") ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.includes("/api/") ||
    path.startsWith("/.status") ||
    path.startsWith("/.docs") ||
    path.startsWith("/.well-known") ||
    path.startsWith("/langsmith")
  )
}

/**
 * The UI catch-all proxies documents and static files (`/assets`, `/fonts`,
 * `/onboarding`, `/:slug/knowledge-graph`). Those are not API traces.
 * API, `/mcp`, `/.auth/api`, and `/.otel` still get spans.
 */
export function isUiProxyPath(path: string): boolean {
  return !isBackendSpanPath(path)
}

export function backendOtelMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"))
    c.header("x-request-id", requestId.id)

    const carrier: Record<string, string> = {}
    const traceparent = c.req.header("traceparent")
    const tracestate = c.req.header("tracestate")
    const baggageHeader = c.req.header("baggage")
    if (traceparent) carrier.traceparent = traceparent
    if (tracestate) carrier.tracestate = tracestate
    if (baggageHeader) carrier.baggage = baggageHeader
    const parent = stripUntrustedAttributionBaggage(
      propagation.extract(context.active(), carrier),
    )

    const safePath = redactSecretPath(c.req.path)
    requestLogger(c)?.set({ path: safePath })

    if (isUiProxyPath(c.req.path)) {
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
      `${c.req.method} ${safePath}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": c.req.method,
          "url.path": safePath,
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
          if (route) {
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
