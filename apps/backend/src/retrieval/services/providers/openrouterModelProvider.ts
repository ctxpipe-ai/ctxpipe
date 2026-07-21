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

function bearerFetch(apiKey: string): OpenAiCompatibleFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

export function openrouterModelProvider(
  opts: ProviderCallOpts,
): ProviderCallResult {
  const baseURL = opts.env.MODEL_PROVIDER_URL?.trim() || DEFAULT_OPENROUTER_BASE
  const primary = opts.models[0] ?? ""
  const fallbacks = opts.models.slice(1)

  const lowered = lowerOpenRouterParams(opts.modelParams)
  const modelKwargs = {
    plugins: [{ id: "context-compression" }],
    cache_control: { type: "ephemeral" as const },
    ...(lowered ?? {}),
    ...(fallbacks.length > 0 && { models: fallbacks }),
  } as Record<string, unknown>

  const fetchFn = bearerFetch(opts.apiKey)

  return {
    chat: new ChatOpenAI({
      model: primary,
      apiKey: opts.apiKey,
      temperature: opts.temperature,
      streaming: opts.streaming ?? true,
      modelKwargs,
      configuration: { baseURL },
    }),
    fetch: fetchFn,
  }
}
