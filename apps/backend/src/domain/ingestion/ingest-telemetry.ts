import { propagateAttributes } from "@langfuse/tracing"
import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { langfusePropagation } from "../../observability/langfuse.js"
import { log } from "../../observability/logger.js"
import type { WorkspaceChatCompletionUsage } from "../workspaces/workspace-chat-model-proxy.js"

/*
 * Telemetry of an ingestion v2 run (ADR-052, T11). Attribute names follow
 * the key table of the observability skill: `ctxpipe.ingest.*` for the run,
 * the shard, and the step (the model proxy sets the same keys on its request
 * span, so a model call joins its step by `ctxpipe.ingest.run.id` and
 * `ctxpipe.ingest.step`). A span holds ids, SHAs, and counts. It never holds
 * a prompt, an answer, a file path of the source, or the text of a file.
 */

/** The longest free text (a reason, a script error) that a log or span keeps. */
export const INGEST_TELEMETRY_TEXT_MAX = 500

/** A free text, cut to `INGEST_TELEMETRY_TEXT_MAX` characters. */
export function capIngestText(text: string): string {
  return text.length > INGEST_TELEMETRY_TEXT_MAX
    ? `${text.slice(0, INGEST_TELEMETRY_TEXT_MAX)}...`
    : text
}

const tracer = () => trace.getTracer("ctxpipe-ingestion")

/**
 * Run `fn` in an `ingestion.*` span. The span gets an error status (the error
 * class only, never its message, which can hold script output) when `fn`
 * throws. `fn` sets the result attributes with `span.setAttributes`.
 */
export function withIngestSpan<T>(
  name: "ingestion.run" | "ingestion.shard" | "ingestion.step",
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span)
    } catch (error) {
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.name : "Error",
      )
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * One log event for an ingestion fact (a rejected op, a `partial` reason).
 * It is its own event, not a field of the run's wide event: the wide event
 * keeps one value for each field, so two rejects would overwrite each other.
 */
export function logIngestEvent(
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
): void {
  log[level]({ step: event, message: event, ...fields })
}

/**
 * The Langfuse session of a run: one session groups the model calls of every
 * shard and step. The id differs from a conversation id.
 */
export function ingestLangfuseSession(runId: string): string {
  return `ingest:${runId}`
}

/**
 * The model call of one ingest step, at the model proxy. It is a generation
 * span with the usage, in the Langfuse session of the run. It holds no
 * prompt or answer (the checkout is customer source).
 */
export function startIngestModelCall(
  ingest: { runId: string; shard: number; step: string },
  model: string,
): {
  finish: (result: {
    status: number
    durationMs: number
    finishReason?: string | null
    responseModel?: string | null
    usage?: WorkspaceChatCompletionUsage | null
  }) => void
} {
  const span = propagateAttributes(
    {
      ...langfusePropagation({
        sessionId: ingestLangfuseSession(ingest.runId),
        tags: ["ingestion"],
        traceMetadata: { ingestShard: String(ingest.shard) },
      }),
      traceName: "ingestion",
    },
    () =>
      tracer().startSpan("ingestion.model_call", {
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": model,
          "ctxpipe.ingest.run.id": ingest.runId,
          "ctxpipe.ingest.shard": String(ingest.shard),
          "ctxpipe.ingest.step": ingest.step,
        },
      }),
  )
  let ended = false
  return {
    finish(result) {
      if (ended) return
      ended = true
      const usage = result.usage
      span.setAttributes({
        "http.response.status_code": result.status,
        "ctxpipe.ingest.model_call.duration_ms": result.durationMs,
        ...(result.finishReason
          ? { "gen_ai.response.finish_reasons": result.finishReason }
          : {}),
        ...(result.responseModel
          ? { "gen_ai.response.model": result.responseModel }
          : {}),
        ...(usage?.inputTokens !== undefined
          ? { "gen_ai.usage.input_tokens": usage.inputTokens }
          : {}),
        ...(usage?.outputTokens !== undefined
          ? { "gen_ai.usage.output_tokens": usage.outputTokens }
          : {}),
        ...(usage?.cachedInputTokens !== undefined
          ? { "gen_ai.usage.cache_read.input_tokens": usage.cachedInputTokens }
          : {}),
        ...(usage?.cost !== undefined
          ? { "gen_ai.usage.cost": usage.cost }
          : {}),
      })
      if (result.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
    },
  }
}
