import {
  type Context,
  isSpanContextValid,
  type Span,
  SpanKind,
} from "@opentelemetry/api"
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base"

/**
 * better-auth 1.6.23 starts every auth operation on tracer scope `better-auth`
 * (`withSpan` in `@better-auth/core`). That version has no option, env var, or
 * tracer injection to disable it. `experimental` is only `{ joins }`.
 * `BETTER_AUTH_TELEMETRY` is the anonymous product ping, not these spans.
 *
 * Keep the endpoint span (`GET /get-session`, `POST /sign-in/email`, …) only
 * when it is a child of our `/.auth/` server span: that span is the request.
 * The same names under `POST /mcp`, UI proxy, or as their own root are session
 * lookups and are dropped. Hook, handler, middleware, and adapter `db *` spans
 * are dropped, including adapter errors. Postgres failures stay on `dbTrace`
 * (`ctxpipe-backend`).
 *
 * Register by wrapping the exporter processor only:
 * `new BetterAuthSpanFilter(new BatchSpanProcessor(traceExporter))`.
 */
const BETTER_AUTH_SCOPE = "better-auth"

const AUTH_ENDPOINT_SPAN = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//

export class BetterAuthSpanFilter implements SpanProcessor {
  private readonly authServerSpanIds = new Set<string>()

  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const readable = span as Span & ReadableSpan
    if (isAuthHttpServerSpan(readable)) {
      this.authServerSpanIds.add(span.spanContext().spanId)
    }
    this.next.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    this.authServerSpanIds.delete(span.spanContext().spanId)
    if (!shouldExport(span, this.authServerSpanIds)) return
    this.next.onEnd(span)
  }

  shutdown(): Promise<void> {
    return this.next.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush()
  }
}

function isAuthHttpServerSpan(span: ReadableSpan): boolean {
  if (span.kind !== SpanKind.SERVER) return false
  const path = span.attributes["url.path"]
  if (
    typeof path === "string" &&
    (path === "/.auth" || path.startsWith("/.auth/"))
  ) {
    return true
  }
  return span.name.includes("/.auth/")
}

function shouldExport(
  span: ReadableSpan,
  authServerSpanIds: ReadonlySet<string>,
): boolean {
  if (span.instrumentationScope.name !== BETTER_AUTH_SCOPE) return true
  if (!AUTH_ENDPOINT_SPAN.test(span.name)) return false
  const parent = span.parentSpanContext
  if (!parent || !isSpanContextValid(parent)) return false
  return authServerSpanIds.has(parent.spanId)
}
