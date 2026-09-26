import { getPropagatedAttributesFromContext } from "@langfuse/core"
import type { Context } from "@opentelemetry/api"
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

/**
 * Copies `propagateAttributes` onto each span at start.
 * `LangfuseSpanProcessor` is not used: it exports straight to Langfuse.
 * ADR-038 keeps a single export to the collector. Langfuse reads
 * `deployment.environment` from the resource set in otel.ts.
 */
export class LangfuseContextSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    span.setAttributes(getPropagatedAttributesFromContext(parentContext))
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}
