import type { ModelParams } from "../modelParams.js"
import type { HostTextAdapter } from "./hostTextAdapter.js"

export type ModelProviderKind =
  | "openai-like"
  | "openrouter"
  | "azure"
  | "bedrock"

export type ModelTier = "fast" | "medium" | "high"

/** HTTP transport for chat and embeddings. */
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
  /** Passed into chat model constructors; omit or `undefined` for embeddings. */
  temperature?: number
  /** Legacy transport setting. Host calls always use a single response. */
  streaming?: boolean
  /** Langfuse generation name of the call. */
  name?: string
  /** Name of the forced structured output tool. */
  outputName?: string
}

export type ProviderCallResult = {
  chat: HostTextAdapter
  fetch: OpenAiCompatibleFetch
  /** Native embedding path when the provider does not use OpenAI-compatible HTTP. */
  embed?: (text: string) => Promise<number[]>
}
