import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"

import { maskCredentialsDeep } from "../domain/workspaces/mask-credentials.js"

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

/** The size limit of the prompt or output JSON on a span. */
const MAX_LLM_CONTENT = 64 * 1024

/**
 * JSON for `gen_ai.input.messages` or `gen_ai.output.messages`, at most
 * `MAX_LLM_CONTENT` characters. Credentials are masked first. A message list
 * keeps its newest whole messages; a text that is still too long keeps its
 * end.
 */
export function llmContent(value: unknown): string {
  let masked = maskCredentialsDeep(value)
  if (Array.isArray(masked)) {
    let size = JSON.stringify(masked).length
    let start = 0
    while (size > MAX_LLM_CONTENT && start < masked.length - 1) {
      size -= JSON.stringify(masked[start]).length + 1
      start += 1
    }
    masked = masked.slice(start)
  }
  let json = JSON.stringify(masked)
  // One message or answer is still too long: keep the end of its text.
  const last = Array.isArray(masked) ? masked.at(-1) : masked
  while (
    json.length > MAX_LLM_CONTENT &&
    last &&
    typeof last === "object" &&
    typeof (last as { content?: unknown }).content === "string"
  ) {
    const item = last as { content: string }
    const keep = item.content.length - (json.length - MAX_LLM_CONTENT) - 32
    if (keep <= 0) {
      item.content = "[truncated]"
      json = JSON.stringify(masked)
      break
    }
    item.content = `[truncated]${item.content.slice(-keep)}`
    json = JSON.stringify(masked)
  }
  return json.length <= MAX_LLM_CONTENT ? json : JSON.stringify("[truncated]")
}

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
    /** The prompt of a chat call: `gen_ai.input.messages`. */
    input?: Record<string, unknown>
    /** The answer of a chat call: `gen_ai.output.messages`. */
    summarizeOutput?: (result: T) => Record<string, unknown>
    /** Plain span attributes, for example the counts of an embeddings batch. */
    attributes?: Record<string, number | string>
    resultAttributes?: (result: T) => Record<string, number | string>
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
        ...(attrs.input
          ? { "gen_ai.input.messages": llmContent(attrs.input) }
          : {}),
        ...attrs.attributes,
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
        if (attrs.summarizeOutput)
          span.setAttribute(
            "gen_ai.output.messages",
            llmContent(attrs.summarizeOutput(result)),
          )
        if (attrs.resultAttributes)
          span.setAttributes(attrs.resultAttributes(result))
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
