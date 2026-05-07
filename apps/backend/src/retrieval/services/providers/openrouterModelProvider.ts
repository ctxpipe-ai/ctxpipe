import { ChatOpenAI } from "@langchain/openai"

import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

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

  const modelKwargs = {
    plugins: [{ id: "context-compression" }],
    cache_control: { type: "ephemeral" as const },
    ...(opts.reasoning === false && {
      reasoning: { effort: "none" as const },
    }),
    ...(fallbacks.length > 0 && { models: fallbacks }),
  } as Record<string, unknown>

  const fetchFn = bearerFetch(opts.apiKey)

  return {
    chat: new ChatOpenAI({
      model: primary,
      apiKey: opts.apiKey,
      temperature: opts.temperature,
      streaming: true,
      modelKwargs,
      configuration: { baseURL },
    }),
    fetch: fetchFn,
  }
}
