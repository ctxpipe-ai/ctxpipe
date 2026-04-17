import { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"

const embeddingEnvSchema = z.object({
  MODEL_PROVIDER_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  MODEL_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
  MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
})

/**
 * OpenAI-compatible provider for AI SDK `embed` / `embedMany` (same endpoints as
 * our previous raw `fetch` to `/embeddings`).
 */
export function getEmbeddingOpenAIProvider() {
  const env = embeddingEnvSchema.parse(process.env)
  const apiKey =
    env.MODEL_EMBEDDING_PROVIDER_API_KEY ?? env.MODEL_PROVIDER_API_KEY ?? ""

  let baseURL: string
  if (env.MODEL_EMBEDDING_PROVIDER_URL) {
    const trimmed = env.MODEL_EMBEDDING_PROVIDER_URL.replace(/\/$/, "")
    baseURL = trimmed.endsWith("/embeddings")
      ? trimmed.slice(0, -"/embeddings".length)
      : trimmed
  } else {
    baseURL = env.MODEL_PROVIDER_URL.replace(/\/$/, "")
  }

  return createOpenAI({
    baseURL,
    apiKey: apiKey.length > 0 ? apiKey : undefined,
    name: "ctxpipe-embeddings",
  })
}

export function getEmbeddingModelName(): string {
  return embeddingEnvSchema.parse(process.env).MODEL_EMBEDDING_NAME
}
