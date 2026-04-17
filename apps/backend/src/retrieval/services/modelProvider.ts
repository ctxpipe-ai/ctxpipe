import { ChatOpenAI } from "@langchain/openai"
import { createAILogger, createEvlogIntegration } from "evlog/ai"
import { embed } from "ai"
import { z } from "zod"
import { getLogger } from "../../observability/logger.js"
import {
  getEmbeddingModelName,
  getEmbeddingOpenAIProvider,
} from "./embeddingProvider.js"

export type ModelTier = "fast" | "medium" | "high"

const EMBEDDING_DIMENSIONS = 2000

const modelEnvSchema = z.object({
  MODEL_PROVIDER_API_KEY: z
    .string()
    .min(1, "MODEL_PROVIDER_API_KEY is required for LLM operations"),
  MODEL_PROVIDER_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  MODEL_FAST_NAME: z.string().default("xiaomi/mimo-v2-flash"),
  MODEL_MEDIUM_NAME: z.string().default("google/gemini-3-flash-preview"),
  MODEL_HIGH_NAME: z.string().default("z-ai/glm-5.1"),
  MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
  MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
})

export type GetModelOptions = {
  temperature?: number
}

/**
 * Returns a ChatOpenAI-compatible model for the given tier.
 * Uses OpenRouter or any OpenAI-compatible provider.
 * OpenRouter: always requests the context-compression plugin and `cache_control: { type: "ephemeral" }` so prompt caching applies where the routed model supports it (see OpenRouter prompt caching docs).
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
  const modelKwargs = isOpenRouter
    ? ({
        plugins: [{ id: "context-compression" }],
        cache_control: { type: "ephemeral" as const },
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
  const modelName = getEmbeddingModelName()
  const openai = getEmbeddingOpenAIProvider()
  let aiLog: ReturnType<typeof createAILogger> | undefined
  try {
    aiLog = createAILogger(getLogger())
  } catch {
    // No request/workflow logger (e.g. standalone scripts) — skip AI wide-event capture.
  }

  const { embedding, usage } = await embed({
    model: openai.embedding(modelName),
    value: text,
    providerOptions: {
      openai: {
        dimensions: EMBEDDING_DIMENSIONS,
      },
    },
    ...(aiLog
      ? {
          experimental_telemetry: {
            isEnabled: true,
            integrations: [createEvlogIntegration(aiLog)],
          },
        }
      : {}),
  })

  aiLog?.captureEmbed({
    usage,
    model: modelName,
    dimensions: EMBEDDING_DIMENSIONS,
  })

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
    )
  }

  return [...embedding]
}
