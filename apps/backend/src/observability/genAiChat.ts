import { AsyncLocalStorage } from "node:async_hooks"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { LLMResult } from "@langchain/core/outputs"
import { ensureConfig } from "@langchain/core/runnables"
import { IterableReadableStream } from "@langchain/core/utils/stream"
import { ChatOpenAI } from "@langchain/openai"
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { collapseRepeatedModelName } from "./collapseRepeatedModelName.js"

/** Lane B excludes this scope from the Langfuse fan-out. ClickHouse still stores it. */
const GEN_AI_TRACER = "ctxpipe-genai"

type Usage = {
  input_tokens?: number
  output_tokens?: number
}

type GenMessage = {
  usage_metadata?: Usage
  response_metadata?: { model_name?: string; finish_reason?: string }
}

type ChatResult = {
  generations?: {
    message?: GenMessage
    generationInfo?: { finish_reason?: string }
  }[][]
  llmOutput?: {
    tokenUsage?: { promptTokens?: number; completionTokens?: number }
    estimatedTokenUsage?: { promptTokens?: number; completionTokens?: number }
  }
}

type ChatInstance = {
  model?: string
  invoke: (input: unknown, options?: CallbackOptions) => Promise<unknown>
  stream: (
    input: unknown,
    options?: CallbackOptions,
  ) => Promise<AsyncIterable<unknown>>
}

type CallbackOptions = {
  callbacks?: unknown
}

const patched = Symbol.for("ctxpipe.genAiChat")
const activeGenAiSpan = new AsyncLocalStorage<Span>()

/**
 * `MODEL_PROVIDER` is how the backend selects the chat client
 * (`openrouter`, `azure`, `bedrock`, or the default `openai-like`).
 * Model ids such as `openai/gpt-5.6-terra` name the upstream model, not the gateway.
 */
export function genAiProviderName(model: string): string {
  const configured = process.env.MODEL_PROVIDER?.trim()
  if (configured && configured !== "openai-like") return configured
  const id = model.split("?")[0] ?? model
  const slash = id.indexOf("/")
  if (slash > 0) {
    const prefix = id.slice(0, slash).trim()
    if (prefix) return prefix
  }
  return "openai"
}

function requestModel(model: ChatInstance): string {
  return typeof model.model === "string" && model.model.length > 0
    ? model.model
    : "unknown"
}

function startChatSpan(model: string): Span {
  const provider = genAiProviderName(model)
  return trace.getTracer(GEN_AI_TRACER).startSpan(`chat ${model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.system": provider,
      "gen_ai.provider.name": provider,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
    },
  })
}

function recordResponse(span: Span, result?: ChatResult): void {
  const generation = result?.generations?.[0]?.[0]
  const message = generation?.message
  const modelName = message?.response_metadata?.model_name
  if (typeof modelName === "string" && modelName.length > 0) {
    span.setAttribute(
      "gen_ai.response.model",
      collapseRepeatedModelName(modelName),
    )
  }
  const finishReason =
    generation?.generationInfo?.finish_reason ??
    message?.response_metadata?.finish_reason
  if (typeof finishReason === "string" && finishReason.length > 0) {
    span.setAttribute("gen_ai.response.finish_reason", finishReason)
  }
  const tokenUsage =
    result?.llmOutput?.tokenUsage ?? result?.llmOutput?.estimatedTokenUsage
  const inputTokens =
    message?.usage_metadata?.input_tokens ?? tokenUsage?.promptTokens
  const outputTokens =
    message?.usage_metadata?.output_tokens ?? tokenUsage?.completionTokens
  if (typeof inputTokens === "number") {
    span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
  }
  if (typeof outputTokens === "number") {
    span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
  }
}

function failSpan(span: Span, error: unknown): void {
  span.recordException(
    error instanceof Error ? error : new Error(String(error)),
  )
  span.setStatus({ code: SpanStatusCode.ERROR })
}

/**
 * Records usage and finish reason. Does not copy prompts or completions onto
 * the span. Langfuse user, session, tags, and metadata arrive from the active
 * context via `LangfuseContextSpanProcessor` when the span starts.
 */
class GenAiChatCallback extends BaseCallbackHandler {
  name = "ctxpipe-genai"

  constructor(private readonly span: Span) {
    super()
  }

  handleLLMNewToken(
    _token: string,
    _idx: unknown,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: {
      chunk?: {
        generationInfo?: { finish_reason?: string; model_name?: string }
        message?: GenMessage
      }
    },
  ): void {
    const info = fields?.chunk?.generationInfo
    const message = fields?.chunk?.message
    if (
      typeof info?.finish_reason === "string" &&
      info.finish_reason.length > 0
    ) {
      this.span.setAttribute(
        "gen_ai.response.finish_reason",
        info.finish_reason,
      )
    }
    if (typeof info?.model_name === "string" && info.model_name.length > 0) {
      this.span.setAttribute(
        "gen_ai.response.model",
        collapseRepeatedModelName(info.model_name),
      )
    }
    const inputTokens = message?.usage_metadata?.input_tokens
    const outputTokens = message?.usage_metadata?.output_tokens
    if (typeof inputTokens === "number") {
      this.span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
    }
    if (typeof outputTokens === "number") {
      this.span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
    }
  }

  handleLLMEnd(output: LLMResult): void {
    recordResponse(this.span, output as ChatResult)
  }
}

/**
 * `ensureConfig` replaces async-local callbacks when `options.callbacks` is set.
 * Merge the caller's handlers (explicit or the LangGraph/Langfuse context)
 * and then append ours, so a partial options object cannot drop them.
 */
function optionsWithGenAiHandler(
  options: CallbackOptions | undefined,
  handler: GenAiChatCallback,
): CallbackOptions {
  const callbacks = ensureConfig(options).callbacks
  let merged: unknown
  if (Array.isArray(callbacks)) merged = callbacks.concat(handler)
  else if (
    callbacks &&
    typeof callbacks === "object" &&
    "copy" in callbacks &&
    typeof callbacks.copy === "function"
  ) {
    merged = (
      callbacks as { copy: (handlers: BaseCallbackHandler[]) => unknown }
    ).copy([handler])
  } else if (callbacks) merged = [callbacks, handler]
  else merged = [handler]
  return { ...(options ?? {}), callbacks: merged }
}

async function* iterateUnderSpan(
  source: AsyncIterable<unknown>,
  span: Span,
): AsyncGenerator<unknown> {
  const ctx = trace.setSpan(context.active(), span)
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await activeGenAiSpan.run(span, () =>
        context.with(ctx, () => iterator.next()),
      )
      if (step.done) return
      yield step.value
    }
  } catch (error) {
    failSpan(span, error)
    throw error
  } finally {
    span.end()
  }
}

/**
 * `@opentelemetry/instrumentation-openai` patches `require("openai")`.
 * Bun ESM `import` of the client inside `@langchain/openai` is a different
 * instance, so ChatOpenAI calls never became gen_ai spans. Install a public
 * callback on the Runnable `invoke` and `stream` entry points instead of
 * patching private `_generate` / `_streamResponseChunks`.
 */
export function installChatOpenAiGenAiSpans(): void {
  const proto = ChatOpenAI.prototype as unknown as ChatInstance & {
    [patched]?: boolean
  }
  if (proto[patched]) return
  proto[patched] = true

  const originalInvoke = proto.invoke
  proto.invoke = async function invoke(input, options) {
    if (activeGenAiSpan.getStore()) {
      return originalInvoke.call(this, input, options)
    }
    const span = startChatSpan(requestModel(this))
    const handler = new GenAiChatCallback(span)
    try {
      return await activeGenAiSpan.run(span, () =>
        context.with(trace.setSpan(context.active(), span), () =>
          originalInvoke.call(
            this,
            input,
            optionsWithGenAiHandler(options, handler),
          ),
        ),
      )
    } catch (error) {
      failSpan(span, error)
      throw error
    } finally {
      span.end()
    }
  }

  const originalStream = proto.stream
  proto.stream = async function stream(input, options) {
    if (activeGenAiSpan.getStore()) {
      return originalStream.call(this, input, options)
    }
    const span = startChatSpan(requestModel(this))
    const handler = new GenAiChatCallback(span)
    ;(this as ChatInstance & { streamUsage?: boolean }).streamUsage = true
    try {
      const iterable = await activeGenAiSpan.run(span, () =>
        originalStream.call(
          this,
          input,
          optionsWithGenAiHandler(options, handler),
        ),
      )
      return IterableReadableStream.fromAsyncGenerator(
        iterateUnderSpan(iterable, span),
      )
    } catch (error) {
      failSpan(span, error)
      span.end()
      throw error
    }
  }
}
