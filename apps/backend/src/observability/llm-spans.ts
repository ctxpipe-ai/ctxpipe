import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"

/*
 * Model call spans with the OpenTelemetry GenAI semantic conventions. HyperDX
 * is the only observability tool (ADR-061).
 */

/** The usage of a model call. `cost` is in USD, as the gateway (OpenRouter) reports it. */
export type LlmUsage = {
  input?: number
  output?: number
  cost?: number
}

const tracer = () => trace.getTracer("ctxpipe-llm")

/**
 * Run `fn` in a generation span: one model call (or one batch of embedding
 * calls) with its model, input, output summary, usage, and cost. The span is
 * active, so the spans of the provider request are its children.
 */
export function withLlmGeneration<T>(
  attrs: {
    name: string
    operation: "chat" | "embeddings"
    model?: string
    provider?: string
    input: Record<string, unknown>
    summarizeOutput: (result: T) => Record<string, unknown>
    usageFromResult?: (result: T) => LlmUsage | undefined
    /**
     * The usage of the calls made so far. Recorded also when the operation
     * fails, so a failed operation keeps the cost of its finished calls.
     */
    usageSoFar?: () => LlmUsage | undefined
  },
  fn: () => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    attrs.name,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": attrs.operation,
        ...(attrs.model ? { "gen_ai.request.model": attrs.model } : {}),
        ...(attrs.provider ? { "gen_ai.provider.name": attrs.provider } : {}),
        "gen_ai.input.messages": JSON.stringify(attrs.input),
      },
    },
    async (span) => {
      const recordUsage = (usage: LlmUsage | undefined) => {
        span.setAttributes({
          ...(usage?.input !== undefined
            ? { "gen_ai.usage.input_tokens": usage.input }
            : {}),
          ...(usage?.output !== undefined
            ? { "gen_ai.usage.output_tokens": usage.output }
            : {}),
          ...(usage?.cost !== undefined
            ? { "gen_ai.usage.cost": usage.cost }
            : {}),
        })
      }
      try {
        const result = await fn()
        span.setAttribute(
          "gen_ai.output.messages",
          JSON.stringify(attrs.summarizeOutput(result)),
        )
        recordUsage(attrs.usageFromResult?.(result) ?? attrs.usageSoFar?.())
        return result
      } catch (err) {
        recordUsage(attrs.usageSoFar?.())
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      } finally {
        span.end()
      }
    },
  )
}
