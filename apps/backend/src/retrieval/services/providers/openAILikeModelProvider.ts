import { ChatOpenAI } from "@langchain/openai"

import type { ModelParams } from "../modelParams.js"
import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

function isNonEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

/** OpenAI / Azure chat completions via LangChain `modelKwargs`. */
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

function bearerFetch(apiKey: string): OpenAiCompatibleFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

export function openAILikeModelProvider(
  opts: ProviderCallOpts,
): ProviderCallResult {
  const baseURL = opts.env.MODEL_PROVIDER_URL?.trim() || DEFAULT_OPENROUTER_BASE
  const primary = opts.models[0] ?? ""
  const modelKwargs = lowerOpenAiChatCompletionsParams(opts.modelParams)
  const fetchFn = bearerFetch(opts.apiKey)

  return {
    chat: new ChatOpenAI({
      model: primary,
      apiKey: opts.apiKey,
      temperature: opts.temperature,
      streaming: true,
      ...(modelKwargs ? { modelKwargs } : {}),
      configuration: { baseURL },
    }),
    fetch: fetchFn,
  }
}
