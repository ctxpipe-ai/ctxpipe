import { context, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import type { MiddlewareHandler } from "hono"
import { contextWithAttributionBag } from "../src/observability/attribution.js"

let contextReady = false

function ensureAsyncContext(): void {
  if (contextReady) return
  contextReady = true
  // Registers the async-hooks context manager. Without it, context.with
  // does not survive the first await inside Hono. Tests call this; the
  // module is outside `src` so production code does not import it.
  new NodeTracerProvider().register()
}

/**
 * Records attribution onto a real span created inside the request, so Hono
 * handlers see it as the active span.
 */
export function attributionRecorder(): {
  middleware: MiddlewareHandler
  attributes: () => Record<string, unknown>
} {
  ensureAsyncContext()
  const tracer = trace.getTracer("ctxpipe-attribution-test")
  let attributes: Record<string, unknown> = {}
  return {
    middleware: async (_c, next) => {
      const { context: withBag } = contextWithAttributionBag(context.active())
      const span = tracer.startSpan("request")
      try {
        await context.with(trace.setSpan(withBag, span), () => next())
      } finally {
        attributes = {
          ...(span as unknown as { attributes: Record<string, unknown> })
            .attributes,
        }
        span.end()
      }
    },
    attributes: () => attributes,
  }
}
