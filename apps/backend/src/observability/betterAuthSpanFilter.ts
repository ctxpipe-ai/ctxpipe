import { type Context, SpanStatusCode } from "@opentelemetry/api"
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

/**
 * better-auth 1.6.23 starts spans on scope `better-auth` and has no off switch.
 * No HyperDX dashboard or saved search reads that scope, so drop it except
 * real failures. An `APIError` is the HTTP answer of better-auth (for example
 * no session on an API-key request), not a failure; the server span has the
 * status code.
 */
export class BetterAuthSpanFilter implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    const failed =
      span.status.code === SpanStatusCode.ERROR &&
      !span.events.some(
        (event) =>
          event.name === "exception" &&
          event.attributes?.["exception.type"] === "APIError",
      )
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
