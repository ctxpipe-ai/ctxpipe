import { type Context, SpanStatusCode } from "@opentelemetry/api"
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

/**
 * better-auth 1.6.23 starts spans on scope `better-auth` and has no off switch.
 * No HyperDX dashboard or saved search reads that scope, so drop it except
 * real failures. A 4xx `APIError` is the HTTP answer of better-auth (for
 * example no session on an API-key request), not a failure. better-auth does
 * not put the status code on the span, so `onStart` records it when the span
 * records the exception.
 */
export class BetterAuthSpanFilter implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    if (span.instrumentationScope.name === "better-auth") {
      const recordException = span.recordException.bind(span)
      span.recordException = (exception, time) => {
        const statusCode = (exception as { statusCode?: unknown }).statusCode
        if (
          (exception as { name?: unknown }).name === "APIError" &&
          typeof statusCode === "number"
        )
          span.setAttribute("http.response.status_code", statusCode)
        recordException(exception, time)
      }
    }
    this.next.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    const status = span.attributes["http.response.status_code"]
    const failed =
      span.status.code === SpanStatusCode.ERROR &&
      !(typeof status === "number" && status >= 400 && status < 500)
    const drop = span.instrumentationScope.name === "better-auth" && !failed
    if (!drop) this.next.onEnd(span)
  }

  shutdown(): Promise<void> {
    return this.next.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush()
  }
}
