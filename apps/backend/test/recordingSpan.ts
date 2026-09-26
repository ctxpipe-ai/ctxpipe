import { context, trace } from "@opentelemetry/api"
import type { MiddlewareHandler } from "hono"
import { contextWithAttributionBag } from "../src/observability/attribution.js"
import { exportedAttributes, recordSpans } from "./spans.js"

const spans = recordSpans()

/**
 * Records attribution onto a real span created inside the request, so Hono
 * handlers see it as the active span. Attributes come from the in-memory
 * exporter in `spans.ts`.
 */
export function attributionRecorder(): {
  middleware: MiddlewareHandler
  attributes: () => Record<string, unknown>
} {
  const tracer = trace.getTracer("ctxpipe-attribution-test")
  let attributes: Record<string, unknown> = {}
  return {
    middleware: async (_c, next) => {
      const { context: withBag } = contextWithAttributionBag(context.active())
      const span = tracer.startSpan("request")
      try {
        await context.with(trace.setSpan(withBag, span), () => next())
      } finally {
        span.end()
        attributes = { ...exportedAttributes(spans, span) }
      }
    },
    attributes: () => attributes,
  }
}
