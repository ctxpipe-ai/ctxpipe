import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

import { log } from "./logger.js"

/**
 * Prompt and output keys. They go only to Langfuse; logs never carry them.
 * The collector `transform/redact_llm_content` rule uses the same pattern.
 */
export const LLM_CONTENT_KEY =
  /^(langfuse\.observation\.(input|output)$|gen_ai\.(prompt|completion|input\.messages|output\.messages))/

/** Compact evlog dump of workspace-chat spans when OTLP/Langfuse is off or alongside it. */
export class EvlogSpanExporter implements SpanExporter {
  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    for (const span of spans) {
      const name = span.name
      if (
        !name.startsWith("workspace-chat") &&
        !name.startsWith("generation #") &&
        !name.startsWith("tool ") &&
        !name.startsWith("chat ")
      ) {
        continue
      }
      const durationMs = span.duration[0] * 1000 + span.duration[1] / 1_000_000
      log.info({
        step: "workspace-chat-otel-span",
        span: name,
        durationMs: Math.round(durationMs),
        attributes: Object.fromEntries(
          Object.entries(span.attributes).filter(
            ([key]) => !LLM_CONTENT_KEY.test(key),
          ),
        ),
      })
    }
    resultCallback({ code: 0 })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
