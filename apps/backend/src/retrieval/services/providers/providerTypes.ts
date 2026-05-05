export type ModelProviderKind =
  | "openai-like"
  | "openrouter"
  | "azure"
  | "bedrock"

export type ModelTier = "fast" | "medium" | "high"

/** OpenAI client `configuration.fetch` / embeddings transport. */
export type OpenAiCompatibleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type ProviderCallEnv = Record<string, string | undefined>

/**
 * Uniform inputs for provider adapters. `models[0]` is the chat model id; remaining
 * entries are provider-specific (e.g. OpenRouter medium-tier fallbacks).
 */
export type ProviderCallOpts = {
  models: string[]
  /** When false, OpenRouter suppresses extended reasoning (`effort: "none"`). Ignored elsewhere. */
  reasoning: boolean
  apiKey: string
  env: ProviderCallEnv
}

export type ProviderCallResult = {
  /** Passed to `new ChatOpenAI({ configuration })` */
  configuration: {
    baseURL: string
    fetch?: OpenAiCompatibleFetch
  }
  modelKwargs?: Record<string, unknown>
  /** Use for embedding HTTP requests (includes auth). */
  fetch: OpenAiCompatibleFetch
}
