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
