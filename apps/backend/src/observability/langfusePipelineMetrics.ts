import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { Serialized } from "@langchain/core/load/serializable"
import type { BaseMessage } from "@langchain/core/messages"
import { getActiveSpanId, updateActiveObservation } from "@langfuse/tracing"
import { getLangfuseHandler } from "./langfuse.js"

/** Avoid Langfuse SDK warn when CallbackHandler hasn't opened an OTEL span yet. */
function mergeActiveObservationMetadata(
  metadata: Record<string, unknown>,
): void {
  if (getActiveSpanId() === undefined) return
  try {
    updateActiveObservation({ metadata })
  } catch {
    /* span ended or incompatible context */
  }
}

function messagesBatchCharEstimate(messages: BaseMessage[][]): number {
  let n = 0
  for (const batch of messages) {
    for (const m of batch) {
      const c = m.content
      n += typeof c === "string" ? c.length : JSON.stringify(c).length
    }
  }
  return n
}

function compactDimensions(
  dimensions?: Record<string, string | undefined>,
): Record<string, string> {
  if (!dimensions) return {}
  return Object.fromEntries(
    Object.entries(dimensions).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

/**
 * Identifies a logical step in a LangGraph / workflow for Langfuse metadata.
 * Use `dimensions` for stable facets (ids, source, org) — omit undefined values.
 */
export type PipelineMetricsContext = {
  step: string
  dimensions?: Record<string, string | undefined>
}

/**
 * LangChain callback: attaches context-size metrics to the active Langfuse observation
 * (via @langfuse/tracing) when OTEL context is present.
 */
export function createPipelineMetricsHandler(
  ctx: PipelineMetricsContext,
): BaseCallbackHandler {
  const toolRunIdToName = new Map<string, string>()
  let llmTurn = 0
  const baseMeta = (): Record<string, unknown> => ({
    pipelineStep: ctx.step,
    ...compactDimensions(ctx.dimensions),
  })

  class PipelineMetricsHandler extends BaseCallbackHandler {
    name = "langfuse-pipeline-metrics"

    handleToolStart(
      tool: Serialized,
      _input: string,
      runId: string,
      _parentRunId?: string,
      _tags?: string[],
      _metadata?: Record<string, unknown>,
      toolName?: string,
    ): void {
      const id = (tool as { id?: string[] }).id
      const resolved =
        toolName ??
        (Array.isArray(id) ? id[id.length - 1] : undefined) ??
        "tool"
      toolRunIdToName.set(runId, resolved)
    }

    handleToolEnd(output: string, runId: string): void {
      const toolName = toolRunIdToName.get(runId) ?? "unknown"
      toolRunIdToName.delete(runId)
      const outputChars = typeof output === "string" ? output.length : 0
      mergeActiveObservationMetadata({
        ...baseMeta(),
        [`llm.tool.${toolName}.outputChars`]: outputChars,
      })
    }

    handleChatModelStart(
      _llm: Serialized,
      messages: BaseMessage[][],
      _runId: string,
    ): void {
      llmTurn += 1
      const inputChars = messagesBatchCharEstimate(messages)
      const approxTokens = Math.ceil(inputChars / 4)
      mergeActiveObservationMetadata({
        ...baseMeta(),
        llmTurn,
        llmInputChars: inputChars,
        llmApproxInputTokens: approxTokens,
      })
    }
  }

  return new PipelineMetricsHandler()
}

/** Langfuse trace handler plus pipeline context / tool-size metrics. */
export function langfusePipelineCallbacks(ctx: PipelineMetricsContext) {
  return [getLangfuseHandler(), createPipelineMetricsHandler(ctx)]
}
