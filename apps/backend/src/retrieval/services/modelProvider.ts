import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"

export type ModelTier = "fast" | "medium" | "high"

const EMBEDDING_DIMENSIONS = 2000

const modelEnvSchema = z.object({
  MODEL_PROVIDER_API_KEY: z
    .string()
    .min(1, "MODEL_PROVIDER_API_KEY is required for LLM operations"),
  MODEL_PROVIDER_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  MODEL_FAST_NAME: z.string().default("xiaomi/mimo-v2-flash"),
  MODEL_MEDIUM_NAME: z.string().default("google/gemini-3-flash-preview"),
  MODEL_HIGH_NAME: z.string().default("z-ai/glm-5"),
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

/**
 * Returns a ChatOpenAI-compatible model for the given tier.
 * Uses OpenRouter or any OpenAI-compatible provider.
 */
export function getModel(tier: ModelTier): ChatOpenAI {
  const env = modelEnvSchema.parse(process.env)
  const modelNames: Record<ModelTier, string> = {
    fast: env.MODEL_FAST_NAME,
    medium: env.MODEL_MEDIUM_NAME,
    high: env.MODEL_HIGH_NAME,
  }
  return new ChatOpenAI({
    model: modelNames[tier],
    apiKey: env.MODEL_PROVIDER_API_KEY,
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
