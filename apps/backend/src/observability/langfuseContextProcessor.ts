import {
  getPropagatedAttributesFromContext,
  LangfuseOtelSpanAttributes,
} from "@langfuse/core"
import type { Context } from "@opentelemetry/api"
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { otelDeploymentEnvironment } from "./otel.js"

/**
 * `@langfuse/langchain` stores userId, sessionId, and tags on the OTEL context
 * inside `propagateAttributes`. Those values land on spans only when a
 * processor copies them during `onStart`. Without this, Langfuse traces stay
 * userId/sessionId null and tags [].
 */
export class LangfuseContextSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const propagated = getPropagatedAttributesFromContext(parentContext)
    const attributes: Record<string, string | string[]> = {
      [LangfuseOtelSpanAttributes.ENVIRONMENT]: otelDeploymentEnvironment(),
      ...propagated,
    }
    const userId = propagated[LangfuseOtelSpanAttributes.TRACE_USER_ID]
    const sessionId = propagated[LangfuseOtelSpanAttributes.TRACE_SESSION_ID]
    if (typeof userId === "string") {
      attributes[LangfuseOtelSpanAttributes.TRACE_COMPAT_USER_ID] = userId
    }
    if (typeof sessionId === "string") {
      attributes[LangfuseOtelSpanAttributes.TRACE_COMPAT_SESSION_ID] = sessionId
    }
    span.setAttributes(attributes)
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}
