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

export function callOpenrouter(opts: ProviderCallOpts): ProviderCallResult {
  const baseURL = opts.env.MODEL_PROVIDER_URL?.trim() || DEFAULT_OPENROUTER_BASE
  const [, ...fallbacks] = opts.models

  const modelKwargs = {
    plugins: [{ id: "context-compression" }],
    cache_control: { type: "ephemeral" as const },
    ...(opts.reasoning === false && {
      reasoning: { effort: "none" as const },
    }),
    ...(fallbacks.length > 0 && { models: fallbacks }),
  } as Record<string, unknown>

  return {
    configuration: { baseURL },
    modelKwargs,
    fetch: bearerFetch(opts.apiKey),
  }
}
