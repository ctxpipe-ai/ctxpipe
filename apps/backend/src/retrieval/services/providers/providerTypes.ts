import type { ChatOpenAI } from "@langchain/openai"

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

/** Fields passed to `new ChatOpenAI(...)` (some providers omit `apiKey`). */
export type ChatOpenAIConstructorOptions = ConstructorParameters<
  typeof ChatOpenAI
>[0]

/**
 * Uniform inputs for provider adapters. Tier builds `[primary, ...fallbacks]` in
 * central code; each adapter uses `models[0]` for chat (and embeddings when
 * only one id is passed).
 */
export type ProviderCallOpts = {
  models: string[]
  /** OpenRouter: when false, sets `reasoning: { effort: "none" }` on fast tier. */
  reasoning: boolean
  apiKey: string
  env: ProviderCallEnv
}

export type ProviderCallResult = {
  /** Spread into `new ChatOpenAI({ ...options, temperature })` from `getModel`. */
  options: ChatOpenAIConstructorOptions
  fetch: OpenAiCompatibleFetch
}
