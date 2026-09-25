import { ChatOpenAI } from "@langchain/openai"
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"

type Usage = {
  input_tokens?: number
  output_tokens?: number
}

type GenMessage = {
  usage_metadata?: Usage
  response_metadata?: { model_name?: string }
}

type ChatResult = {
  generations?: { message?: GenMessage }[]
  llmOutput?: {
    tokenUsage?: { promptTokens?: number; completionTokens?: number }
    estimatedTokenUsage?: { promptTokens?: number; completionTokens?: number }
  }
}

type ChatInstance = {
  model?: string
  _generate: (
    messages: unknown,
    options: unknown,
    runManager?: unknown,
  ) => Promise<ChatResult>
  _streamResponseChunks: (
    messages: unknown,
    options: unknown,
    runManager?: unknown,
  ) => AsyncGenerator<{ message?: GenMessage }>
}

const patched = Symbol.for("ctxpipe.genAiChat")

function collapseRepeatedModelName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 2) return name
  for (let size = 1; size <= trimmed.length / 2; size++) {
    if (trimmed.length % size !== 0) continue
    const unit = trimmed.slice(0, size)
    if (
      trimmed.length / size > 1 &&
      unit.repeat(trimmed.length / size) === trimmed
    ) {
      return unit
    }
  }
  return name
}

function requestModel(model: ChatInstance): string {
  return typeof model.model === "string" && model.model.length > 0
    ? model.model
    : "unknown"
}

function startChatSpan(model: string): Span {
  return trace.getTracer("ctxpipe-backend").startSpan(`chat ${model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.system": "openai",
      "gen_ai.provider.name": "openai",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
    },
  })
}

function recordResponse(
  span: Span,
  message: GenMessage | undefined,
  result?: ChatResult,
): void {
  const modelName = message?.response_metadata?.model_name
  if (typeof modelName === "string" && modelName.length > 0) {
    span.setAttribute(
      "gen_ai.response.model",
      collapseRepeatedModelName(modelName),
    )
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
 * `@opentelemetry/instrumentation-openai` patches `require("openai")`.
 * Bun ESM `import` of the client inside `@langchain/openai` is a different
 * instance, so ChatOpenAI calls never became gen_ai spans. Wrap the class
 * LangChain actually invokes.
 */
export function installChatOpenAiGenAiSpans(): void {
  const proto = ChatOpenAI.prototype as unknown as ChatInstance & {
    [patched]?: boolean
  }
  if (proto[patched]) return
  proto[patched] = true

  const originalGenerate = proto._generate
  proto._generate = async function generate(messages, options, runManager) {
    const span = startChatSpan(requestModel(this))
    try {
      const result = await context.with(
        trace.setSpan(context.active(), span),
        () => originalGenerate.call(this, messages, options, runManager),
      )
      recordResponse(span, result.generations?.[0]?.message, result)
      return result
    } catch (error) {
      failSpan(span, error)
      throw error
    } finally {
      span.end()
    }
  }

  const originalStream = proto._streamResponseChunks
  proto._streamResponseChunks = async function* stream(
    messages,
    options,
    runManager,
  ) {
    const span = startChatSpan(requestModel(this))
    try {
      let last: GenMessage | undefined
      for await (const chunk of originalStream.call(
        this,
        messages,
        options,
        runManager,
      )) {
        if (chunk.message) last = chunk.message
        yield chunk
      }
      recordResponse(span, last)
    } catch (error) {
      failSpan(span, error)
      throw error
    } finally {
      span.end()
    }
  }
}
