import type { ChatOpenAI } from "@langchain/openai"

import type { ModelParams } from "../modelParams.js"

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
 * Uniform inputs for provider adapters. Tier builds `[primary, ...fallbacks]` in
 * central code; each adapter uses `models[0]` for chat (and embeddings when
 * only one id is passed).
 */
export type ProviderCallOpts = {
  models: string[]
  modelParams?: ModelParams
  apiKey: string
  env: ProviderCallEnv
  /** Passed into `ChatOpenAI` for chat; omit or `undefined` for embeddings. */
  temperature?: number
}

export type ProviderCallResult = {
  chat: ChatOpenAI
  fetch: OpenAiCompatibleFetch
}
