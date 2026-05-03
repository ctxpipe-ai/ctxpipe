import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"

export type ModelTier = "fast" | "medium" | "high"

const EMBEDDING_DIMENSIONS = 2000

const modelEnvSchema = z.object({
  MODEL_PROVIDER_API_KEY: z
    .string()
    .min(1, "MODEL_PROVIDER_API_KEY is required for LLM operations"),
  MODEL_PROVIDER_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  MODEL_FAST_NAME: z.string().default("google/gemini-3-flash-preview"),
  MODEL_MEDIUM_NAME: z.string().default("deepseek/deepseek-v4-flash"),
  MODEL_HIGH_NAME: z.string().default("moonshotai/kimi-k2.6"),
  MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
  MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
})

const embeddingEnvSchema = z.object({
  MODEL_PROVIDER_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  MODEL_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
  MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
})

export type GetModelOptions = {
  temperature?: number
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

/**
 * Returns a ChatOpenAI-compatible model for the given tier.
 * Uses OpenRouter or any OpenAI-compatible provider.
 * OpenRouter: always requests the context-compression plugin and `cache_control: { type: "ephemeral" }` so prompt caching applies where the routed model supports it (see OpenRouter prompt caching docs).
 * OpenRouter **fast** tier: `reasoning: { effort: "none" }` so models that support configurable reasoning (e.g. Gemini 3 Flash) do not run extended thinking; see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 * OpenRouter **medium** tier: adds a `models` fallback chain (primary → Gemini 3 Flash → Kimi K2.6) per https://openrouter.ai/docs/guides/routing/model-fallbacks — fallbacks use `MODEL_FAST_NAME` and `MODEL_HIGH_NAME` so they stay aligned with tier overrides.
 */
export function getModel(
  tier: ModelTier,
  options?: GetModelOptions,
): ChatOpenAI {
  const env = modelEnvSchema.parse(process.env)
  const modelNames: Record<ModelTier, string> = {
    fast: env.MODEL_FAST_NAME,
    medium: env.MODEL_MEDIUM_NAME,
    high: env.MODEL_HIGH_NAME,
  }
  const isOpenRouter = env.MODEL_PROVIDER_URL.includes("openrouter.ai")
  const mediumFallbacks =
    tier === "medium" && isOpenRouter
      ? uniqueModelIdsInOrder([
          env.MODEL_FAST_NAME,
          env.MODEL_HIGH_NAME,
        ]).filter((id) => id !== modelNames.medium)
      : []

  const modelKwargs = isOpenRouter
    ? ({
        plugins: [{ id: "context-compression" }],
        cache_control: { type: "ephemeral" as const },
        ...(tier === "fast" && {
          reasoning: { effort: "none" as const },
        }),
        ...(mediumFallbacks.length > 0 && { models: mediumFallbacks }),
      } as Record<string, unknown>)
    : undefined

  return new ChatOpenAI({
    model: modelNames[tier],
    apiKey: env.MODEL_PROVIDER_API_KEY,
    temperature: options?.temperature,
    streaming: true,
    ...(modelKwargs && { modelKwargs }),
    configuration: {
      baseURL: env.MODEL_PROVIDER_URL,
    },
  })
}

/**
 * Generates a 2000-dimensional embedding for text using an OpenAI-compatible
 * embeddings API (OpenRouter, OpenAI, Vertex, Bedrock, Ollama /v1/embeddings, etc.).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const env = embeddingEnvSchema.parse(process.env)
  const url =
    env.MODEL_EMBEDDING_PROVIDER_URL ??
    `${env.MODEL_PROVIDER_URL.replace(/\/$/, "")}/embeddings`
  const apiKey =
    env.MODEL_EMBEDDING_PROVIDER_API_KEY ?? env.MODEL_PROVIDER_API_KEY ?? ""

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
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
