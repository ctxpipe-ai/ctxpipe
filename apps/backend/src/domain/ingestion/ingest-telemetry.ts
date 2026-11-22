import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"

import { log } from "../../observability/logger.js"
import { isWorkflowControlSignal } from "../../openworkflow/isSleepSignal.js"
import type { WorkspaceChatCompletionUsage } from "../workspaces/workspace-chat-model-proxy.js"
import type { IngestModelTier } from "./ingest-opencode.js"

/*
 * Telemetry of an ingestion v2 run (ADR-052, T11). Attribute names follow
 * the key table of the observability skill: `ctxpipe.ingest.*` for the run,
 * the shard, and the step (the model proxy sets the same keys on its request
 * span, so a model call joins its step by `ctxpipe.ingest.run.id` and
 * `ctxpipe.ingest.step`). A span holds ids, SHAs, and counts. It never holds
 * a prompt, an answer, a file path of the source, or the text of a file.
 */

/** The limit for a trusted diagnostic. This does not redact source text. */
export const INGEST_TELEMETRY_TEXT_MAX = 500

/** Keep the tail of a diagnostic so its last error line remains visible. */
export function capIngestText(text: string): string {
  return text.length > INGEST_TELEMETRY_TEXT_MAX
    ? `...${text.slice(-INGEST_TELEMETRY_TEXT_MAX)}`
    : text
}

/**
 * The log fields of a failed ingest step. An error message or `name` can
 * hold source text, so the fields hold only the class of the error, a
 * system error code, and the start of a message from this list. The list
 * holds only messages with no source text. The code can sit on the error,
 * or on its cause. A failed `fetch` keeps its code on the cause, for
 * example `UND_ERR_SOCKET`.
 *
 * `errorHead` is the cause of a failed Git transport, from the stderr in the
 * message of a failed root command (`runAsRoot`, CTX-1517). It comes only
 * from the line that Git writes for a transport failure, `fatal: unable to
 * access '<url>': <curl error>`, and only when the curl error starts with a
 * head from this closed list. Each head is fixed text plus at most a status
 * code, so it holds no URL, host, path, or token.
 */
export function ingestErrorFields(error: unknown): {
  errorClass: string
  errorCode?: string
  errorKind?: string
  errorHead?: string
} {
  if (!(error instanceof Error)) return { errorClass: typeof error }
  const ownCode = (error as { code?: unknown }).code
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code
  const code = typeof ownCode === "string" ? ownCode : causeCode
  const kind =
    /^(?:Ingest root command failed \(exit -?\d+\)|Sandbox lock ownership (?:lost|expired)|The ingest step reached its time limit|\(HTTP code \d{3}\)|aborted$|socket hang up$|fetch failed$|terminated$|discover-roots failed)/.exec(
      error.message,
    )?.[0]
  const head = kind?.startsWith("Ingest root command failed")
    ? /^fatal: unable to access '[^'\n]*': (?:Failed to connect to [^\n]*?: |Recv failure: )?(CONNECT tunnel failed, response \d{3}|Received HTTP code \d{3} from proxy after CONNECT|Proxy CONNECT aborted|Could not resolve proxy|Couldn't connect to server|Connection refused|Connection reset by peer|Connection timed out|Operation timed out)(?=$|[: ])/m.exec(
        error.message.slice(kind.length + 2),
      )?.[1]
    : undefined
  return {
    errorClass: error.constructor.name,
    ...(typeof code === "string" &&
    /^(?:E[A-Z0-9_]{2,40}|UND_ERR_[A-Z_]{1,40})$/.test(code)
      ? { errorCode: code }
      : {}),
    ...(kind ? { errorKind: kind } : {}),
    ...(head ? { errorHead: head } : {}),
  }
}

const tracer = () => trace.getTracer("ctxpipe-ingestion")

/**
 * Run `fn` in an `ingestion.*` span. The span gets an error status (the error
 * type is fixed, never its message or name, which can hold source text) when `fn`
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
      if (!isWorkflowControlSignal(error)) {
        span.setAttribute("error.type", "Error")
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * The span attributes of the bundle that runs a run or a shard, against
 * the bundle that the run planned with: a deploy can change it (CTX-1503).
 */
export function ingestBundleAttributes(
  planned: string,
  current: string,
): Record<string, string | boolean> {
  return {
    "ctxpipe.ingest.bundle.current": current,
    "ctxpipe.ingest.bundle.changed": current !== planned,
  }
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
 * The model call of one ingest step, at the model proxy. It is a generation
 * span with the usage. `ctxpipe.ingest.run.id` groups the model calls of
 * every shard and step of a run. It holds no prompt or answer (the checkout
 * is customer source).
 */
export function startIngestModelCall(
  ingest: { runId: string; shard: number; step: string },
  call: { tier: IngestModelTier; model: string },
): {
  finish: (result: {
    status: number
    durationMs: number
    finishReason?: string | null
    responseModel?: string | null
    usage?: WorkspaceChatCompletionUsage | null
  }) => void
} {
  const span = tracer().startSpan("ingestion.model_call", {
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": call.model,
      "ctxpipe.ingest.model_tier": call.tier,
      "ctxpipe.ingest.run.id": ingest.runId,
      "ctxpipe.ingest.shard": String(ingest.shard),
      "ctxpipe.ingest.step": ingest.step,
    },
  })
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
      if (result.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
    },
  }
}

/**
 * Export a run summary only when the execution ends, not when it parks. The
 * span gets an error status when `fn` throws, or when `fn` sets
 * `error.type` (a run that dropped the output of a Workspace, CTX-1482).
 */
export async function withIngestRunSpan<T>(
  attributes: Attributes,
  fn: (attributes: Attributes) => Promise<T>,
): Promise<T> {
  const startTime = new Date()
  let parked = false
  let failed = false
  try {
    return await fn(attributes)
  } catch (error) {
    parked = isWorkflowControlSignal(error)
    failed = !parked
    throw error
  } finally {
    if (!parked) {
      const span = tracer().startSpan("ingestion.run", {
        attributes,
        startTime,
      })
      if (failed) span.setAttribute("error.type", "Error")
      if (failed || attributes["error.type"] !== undefined)
        span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
    }
  }
}
