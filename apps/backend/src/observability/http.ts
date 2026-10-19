import { httpInstrumentationMiddleware } from "@hono/otel"
import { context, SpanStatusCode, trace } from "@opentelemetry/api"
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
function isUiProxyRequest(c: Context): boolean {
  const responder = matchedRoutes(c).find((route) => route.handler.length < 2)
  return responder?.path === "/*" || responder?.path === "*"
}

/**
 * A page load through the UI catch-all. It gets a server span so that its log
 * has a trace id and the server render joins one trace. Assets and other
 * proxied files stay without a span to limit volume.
 */
function isPageDocumentRequest(c: Context): boolean {
  if (c.req.method !== "GET") return false
  const dest = c.req.header("sec-fetch-dest")
  if (dest) return dest === "document"
  return c.req.header("accept")?.includes("text/html") ?? false
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

/**
 * `@hono/otel` ends the server span when the handler returns, which is at
 * the headers of a streamed answer. A child span covers the stream until
 * its last chunk, so the trace shows the real duration.
 */
function coverStreamedBody(c: Context): void {
  const body = c.res.body
  const type = c.res.headers.get("content-type") ?? ""
  if (!body || !/^text\/event-stream\b/i.test(type)) return
  const span = trace
    .getTracer("ctxpipe-backend")
    .startSpan("http.response.stream")
  const reader = body.getReader()
  const streamed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          span.end()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        span.recordException(error as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
        controller.error(error)
      }
    },
    async cancel(reason) {
      // The client left; that is not a failure of this service.
      span.setAttribute("http.response.stream.canceled", true)
      span.end()
      await reader.cancel(reason)
    },
  })
  c.res = new Response(streamed, c.res)
}

export function backendOtelMiddleware(): MiddlewareHandler {
  const instrument = httpInstrumentationMiddleware({
    captureActiveRequests: false,
  })

  return async (c, next) => {
    const requestId = ensureRequestId(c)
    const { context: traced, bag } = contextWithAttributionBag(context.active())
    bag.set("request.id", requestId)
    const uiProxy = isUiProxyRequest(c)
    const untraced = uiProxy && !isPageDocumentRequest(c)

    await context.with(traced, async () => {
      if (untraced) {
        await next()
        return
      }
      await instrument(c, async () => {
        const span = trace.getActiveSpan()
        const safePath = redactSecretPath(c.req.path)
        span?.setAttribute("url.path", safePath)
        span?.setAttribute("request.id", requestId)
        const userAgent = c.req.header("user-agent")
        if (userAgent) span?.setAttribute("user_agent.original", userAgent)
        try {
          await next()
          if (uiProxy && span) {
            // The HyperDX browser document-load span links to this span. Set
            // it on the final response: the UI proxy returns its own Response.
            const { traceId, spanId, traceFlags } = span.spanContext()
            const flags = traceFlags.toString(16).padStart(2, "0")
            c.res.headers.set(
              "server-timing",
              `traceparent;desc="00-${traceId}-${spanId}-${flags}"`,
            )
          }
        } finally {
          if (span) copyAttributionToSpan(span, context.active())
        }
        coverStreamedBody(c)
      })
    })

    if (!untraced && isRailwayPrEnvironment()) {
      setTimeout(() => {
        void forceFlushOtel()
      }, 0)
    }
  }
}
