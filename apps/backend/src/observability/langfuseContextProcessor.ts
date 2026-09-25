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
 * Collector `filter/llm_only` forwards langfuse/langchain/langgraph scopes and
 * spans that already carry `gen_ai.*`, and drops `ctxpipe-genai`. The
 * environment attribute is only useful on spans that fan out to Langfuse.
 */
function isLangfuseFanoutSpan(span: Span): boolean {
  const readable = span as Span & {
    instrumentationScope?: { name?: string }
    attributes?: Record<string, unknown>
  }
  const scope = readable.instrumentationScope?.name ?? ""
  if (scope === "ctxpipe-genai") return false
  if (/langfuse|langchain|langgraph/i.test(scope)) return true
  const attributes = readable.attributes
  if (!attributes) return false
  return Object.keys(attributes).some((key) => key.startsWith("gen_ai."))
}

/**
 * `@langfuse/langchain` stores userId, sessionId, and tags on the OTEL context
 * inside `propagateAttributes`. Those values land on spans only when a
 * processor copies them during `onStart`. Without this, Langfuse traces stay
 * userId/sessionId null and tags [].
 */
export class LangfuseContextSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const propagated = getPropagatedAttributesFromContext(parentContext)
    const attributes: Record<string, string | string[]> = { ...propagated }
    if (isLangfuseFanoutSpan(span)) {
      attributes[LangfuseOtelSpanAttributes.ENVIRONMENT] =
        otelDeploymentEnvironment()
    }
    if (Object.keys(attributes).length === 0) return
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
