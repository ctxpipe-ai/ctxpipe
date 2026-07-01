import type { ModelParams } from "../modelParams.js"

function isNonEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

/** OpenAI / Azure / Bedrock Chat Completions via LangChain `modelKwargs`. */
export function lowerOpenAiChatCompletionsParams(
  params: ModelParams | undefined,
): Record<string, unknown> | undefined {
  if (!params) return undefined

  const out: Record<string, unknown> = {}

  if (params.reasoning?.effort !== undefined) {
    out.reasoning_effort = params.reasoning.effort
  }

  if (params.text?.verbosity !== undefined) {
    out.verbosity = params.text.verbosity
  }

  if (params.sampling?.maxTokens !== undefined) {
    out.max_tokens = params.sampling.maxTokens
  }
  if (params.sampling?.topP !== undefined) {
    out.top_p = params.sampling.topP
  }
  if (params.sampling?.seed !== undefined) {
    out.seed = params.sampling.seed
  }
  if (params.sampling?.presencePenalty !== undefined) {
    out.presence_penalty = params.sampling.presencePenalty
  }
  if (params.sampling?.frequencyPenalty !== undefined) {
    out.frequency_penalty = params.sampling.frequencyPenalty
  }

  if (params.bedrock && isNonEmptyRecord(params.bedrock)) {
    Object.assign(out, params.bedrock)
  }
  if (params.azure && isNonEmptyRecord(params.azure)) {
    Object.assign(out, params.azure)
  }

  return isNonEmptyRecord(out) ? out : undefined
}

/** OpenRouter gateway request body fields via LangChain `modelKwargs`. */
export function lowerOpenRouterParams(
  params: ModelParams | undefined,
): Record<string, unknown> | undefined {
  if (!params) return undefined

  const out: Record<string, unknown> = {}

  if (params.reasoning) {
    const reasoning: Record<string, unknown> = {}
    if (params.reasoning.effort !== undefined) {
      reasoning.effort = params.reasoning.effort
    }
    if (params.reasoning.maxTokens !== undefined) {
      reasoning.max_tokens = params.reasoning.maxTokens
    }
    if (params.reasoning.exclude !== undefined) {
      reasoning.exclude = params.reasoning.exclude
    }
    if (params.reasoning.enabled !== undefined) {
      reasoning.enabled = params.reasoning.enabled
    }
    if (params.reasoning.summary !== undefined) {
      reasoning.summary = params.reasoning.summary
    }
    if (isNonEmptyRecord(reasoning)) {
      out.reasoning = reasoning
    }
  }

  if (params.text?.verbosity !== undefined) {
    out.verbosity = params.text.verbosity
  }

  if (params.sampling?.maxTokens !== undefined) {
    out.max_tokens = params.sampling.maxTokens
  }
  if (params.sampling?.topP !== undefined) {
    out.top_p = params.sampling.topP
  }
  if (params.sampling?.seed !== undefined) {
    out.seed = params.sampling.seed
  }
  if (params.sampling?.presencePenalty !== undefined) {
    out.presence_penalty = params.sampling.presencePenalty
  }
  if (params.sampling?.frequencyPenalty !== undefined) {
    out.frequency_penalty = params.sampling.frequencyPenalty
  }

  if (params.openrouter && isNonEmptyRecord(params.openrouter)) {
    Object.assign(out, params.openrouter)
  }

  return isNonEmptyRecord(out) ? out : undefined
}
