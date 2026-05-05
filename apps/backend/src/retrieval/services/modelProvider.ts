import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"

import { createBedrockSigV4Fetch } from "./bedrockOpenAiFetch.js"

/** Matches OpenAI SDK `fetch` override shape; kept local to avoid a direct `openai` dependency. */
type OpenAiCompatibleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type ModelTier = "fast" | "medium" | "high"

export type ModelProviderKind =
  | "openai-like"
  | "openrouter"
  | "azure"
  | "bedrock"

const EMBEDDING_DIMENSIONS = 2000

const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

const modelProviderSchema = z.enum([
  "openai-like",
  "openrouter",
  "azure",
  "bedrock",
])

function hasAwsIamEnv(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
      process.env.AWS_SECRET_ACCESS_KEY?.trim(),
  )
}

const modelEnvSchema = z
  .object({
    MODEL_PROVIDER: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      modelProviderSchema.default("openai-like"),
    ),
    MODEL_PROVIDER_API_KEY: z.string().optional(),
    MODEL_PROVIDER_URL: z.string().url().optional(),
    MODEL_BEDROCK_AWS_REGION: z.string().optional(),
    MODEL_FAST_NAME: z.string().default("google/gemini-3-flash-preview"),
    MODEL_MEDIUM_NAME: z.string().default("deepseek/deepseek-v4-flash"),
    MODEL_HIGH_NAME: z.string().default("moonshotai/kimi-k2.6"),
    MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
    MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
    MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
  })
  .superRefine((data, ctx) => {
    if (data.MODEL_PROVIDER === "azure" || data.MODEL_PROVIDER === "bedrock") {
      if (!data.MODEL_PROVIDER_URL?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: `MODEL_PROVIDER_URL is required when MODEL_PROVIDER is ${data.MODEL_PROVIDER}`,
          path: ["MODEL_PROVIDER_URL"],
        })
      }
    }

    if (data.MODEL_PROVIDER === "bedrock") {
      const hasKey = Boolean(data.MODEL_PROVIDER_API_KEY?.trim())
      if (!hasKey && !hasAwsIamEnv()) {
        ctx.addIssue({
          code: "custom",
          message:
            "Bedrock requires MODEL_PROVIDER_API_KEY or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
          path: ["MODEL_PROVIDER_API_KEY"],
        })
      }
    } else if (!data.MODEL_PROVIDER_API_KEY?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "MODEL_PROVIDER_API_KEY is required for LLM operations",
        path: ["MODEL_PROVIDER_API_KEY"],
      })
    }
  })

const embeddingEnvSchema = z
  .object({
    MODEL_PROVIDER: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      modelProviderSchema.default("openai-like"),
    ),
    MODEL_PROVIDER_URL: z.string().url().optional(),
    MODEL_PROVIDER_API_KEY: z.string().optional(),
    MODEL_BEDROCK_AWS_REGION: z.string().optional(),
    MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
    MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
    MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
  })
  .superRefine((data, ctx) => {
    const embedUrl =
      data.MODEL_EMBEDDING_PROVIDER_URL ?? data.MODEL_PROVIDER_URL
    if (data.MODEL_PROVIDER === "azure" || data.MODEL_PROVIDER === "bedrock") {
      if (!embedUrl?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: `MODEL_EMBEDDING_PROVIDER_URL or MODEL_PROVIDER_URL is required when MODEL_PROVIDER is ${data.MODEL_PROVIDER}`,
          path: ["MODEL_EMBEDDING_PROVIDER_URL"],
        })
      }
    }

    const embedKey =
      data.MODEL_EMBEDDING_PROVIDER_API_KEY ?? data.MODEL_PROVIDER_API_KEY

    if (data.MODEL_PROVIDER === "bedrock") {
      const hasKey = Boolean(embedKey?.trim())
      if (!hasKey && !hasAwsIamEnv()) {
        ctx.addIssue({
          code: "custom",
          message:
            "Embeddings on Bedrock need MODEL_EMBEDDING_PROVIDER_API_KEY or MODEL_PROVIDER_API_KEY, or IAM env credentials",
          path: ["MODEL_PROVIDER_API_KEY"],
        })
      }
    } else if (!embedKey?.trim()) {
      ctx.addIssue({
        code: "custom",
        message:
          "MODEL_EMBEDDING_PROVIDER_API_KEY or MODEL_PROVIDER_API_KEY is required for embeddings",
        path: ["MODEL_PROVIDER_API_KEY"],
      })
    }
  })

export type GetModelOptions = {
  temperature?: number
}

function resolveChatBaseUrl(
  provider: ModelProviderKind,
  url: string | undefined,
): string {
  if (provider === "azure" || provider === "bedrock") {
    return url as string
  }
  return url?.trim() ? url : DEFAULT_OPENROUTER_BASE
}

function resolveEmbeddingBaseUrl(env: z.infer<typeof embeddingEnvSchema>): string {
  const chatBase = resolveChatBaseUrl(
    env.MODEL_PROVIDER,
    env.MODEL_PROVIDER_URL,
  )
  return (
    env.MODEL_EMBEDDING_PROVIDER_URL ??
    `${chatBase.replace(/\/$/, "")}/embeddings`
  )
}

function openRouterModelKwargs(
  tier: ModelTier,
  fast: string,
  medium: string,
  high: string,
): Record<string, unknown> | undefined {
  const modelNames: Record<ModelTier, string> = {
    fast,
    medium,
    high,
  }
  const mediumFallbacks =
    tier === "medium"
      ? uniqueModelIdsInOrder([fast, high]).filter((id) => id !== modelNames.medium)
      : []

  return {
    plugins: [{ id: "context-compression" }],
    cache_control: { type: "ephemeral" as const },
    ...(tier === "fast" && {
      reasoning: { effort: "none" as const },
    }),
    ...(mediumFallbacks.length > 0 && { models: mediumFallbacks }),
  } as Record<string, unknown>
}

/** Dedupes while preserving order (for OpenRouter `models` fallback chain). */
function uniqueModelIdsInOrder(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Azure OpenAI expects `api-key`, not `Authorization: Bearer` — strip Bearer and attach `api-key`. */
function createAzureApiKeyFetch(apiKey: string): OpenAiCompatibleFetch {
  return async (input, init): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.delete("Authorization")
    headers.set("api-key", apiKey)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

function chatClientOptions(args: {
  provider: ModelProviderKind
  baseUrl: string
  apiKey: string
  bedrockRegion?: string | undefined
}): { baseURL: string; fetch?: OpenAiCompatibleFetch } {
  const { provider, baseUrl, apiKey, bedrockRegion } = args

  if (provider === "azure") {
    return {
      baseURL: baseUrl,
      fetch: createAzureApiKeyFetch(apiKey),
    }
  }

  if (provider === "bedrock") {
    if (apiKey.trim()) {
      return { baseURL: baseUrl }
    }
    return {
      baseURL: baseUrl,
      fetch: createBedrockSigV4Fetch(baseUrl, bedrockRegion?.trim()),
    }
  }

  return { baseURL: baseUrl }
}

function embeddingHeadersAndFetch(args: {
  provider: ModelProviderKind
  embedUrl: string
  apiKey: string
  bedrockRegion?: string | undefined
}): { headers: Record<string, string>; customFetch?: OpenAiCompatibleFetch } {
  const { provider, embedUrl, apiKey, bedrockRegion } = args

  if (provider === "azure") {
    return {
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
    }
  }

  if (provider === "bedrock") {
    if (apiKey.trim()) {
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    }
    return {
      headers: { "Content-Type": "application/json" },
      customFetch: createBedrockSigV4Fetch(embedUrl, bedrockRegion?.trim()),
    }
  }

  return {
    headers: {
      "Content-Type": "application/json",
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
  }
}

/**
 * Returns a ChatOpenAI-compatible model for the given tier.
 * Uses OpenRouter or any OpenAI-compatible provider.
 * **`MODEL_PROVIDER=openrouter`**: context-compression plugin, `cache_control: { type: "ephemeral" }`, fast-tier `reasoning: { effort: "none" }`, medium-tier `models` fallbacks — see OpenRouter docs.
 */
export function getModel(
  tier: ModelTier,
  options?: GetModelOptions,
): ChatOpenAI {
  const env = modelEnvSchema.parse(process.env)
  const baseUrl = resolveChatBaseUrl(env.MODEL_PROVIDER, env.MODEL_PROVIDER_URL)

  const modelNames: Record<ModelTier, string> = {
    fast: env.MODEL_FAST_NAME,
    medium: env.MODEL_MEDIUM_NAME,
    high: env.MODEL_HIGH_NAME,
  }

  const useOpenRouterExtras = env.MODEL_PROVIDER === "openrouter"
  const modelKwargs = useOpenRouterExtras
    ? openRouterModelKwargs(
        tier,
        env.MODEL_FAST_NAME,
        env.MODEL_MEDIUM_NAME,
        env.MODEL_HIGH_NAME,
      )
    : undefined

  const apiKey = env.MODEL_PROVIDER_API_KEY?.trim() ?? ""

  const omitTopLevelApiKey =
    env.MODEL_PROVIDER === "bedrock" && !apiKey

  const configuration = chatClientOptions({
    provider: env.MODEL_PROVIDER,
    baseUrl,
    apiKey,
    bedrockRegion: env.MODEL_BEDROCK_AWS_REGION,
  })

  return new ChatOpenAI({
    model: modelNames[tier],
    ...(omitTopLevelApiKey ? {} : { apiKey }),
    temperature: options?.temperature,
    streaming: true,
    ...(modelKwargs && { modelKwargs }),
    configuration,
  })
}

/**
 * Generates a 2000-dimensional embedding for text using an OpenAI-compatible
 * embeddings API (OpenRouter, OpenAI, Vertex, Bedrock, Ollama /v1/embeddings, etc.).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const env = embeddingEnvSchema.parse(process.env)
  const embedUrl = resolveEmbeddingBaseUrl(env)

  const apiKey =
    env.MODEL_EMBEDDING_PROVIDER_API_KEY?.trim() ??
    env.MODEL_PROVIDER_API_KEY?.trim() ??
    ""

  const { headers, customFetch } = embeddingHeadersAndFetch({
    provider: env.MODEL_PROVIDER,
    embedUrl,
    apiKey,
    bedrockRegion: env.MODEL_BEDROCK_AWS_REGION,
  })

  const doFetch = customFetch ?? (fetch as OpenAiCompatibleFetch)
  const res = await doFetch(embedUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.MODEL_EMBEDDING_NAME,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  })

  if (!res.ok) {
    throw new Error(`Embedding failed: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as {
    data?: { embedding?: number[] }[]
  }

  const embedding = data.data?.[0]?.embedding ?? []

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
    )
  }

  return embedding
}
