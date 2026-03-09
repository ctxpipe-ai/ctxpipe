import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"

export type ModelTier = "fast" | "medium" | "high"

/**
 * Model IDs per tier (OpenRouter). Engineering-focused, latest generation.
 * Selected for price/performance from OpenRouter pricing and benchmarks.
 * Eventually configurable via DB.
 */
const MODEL_IDS: Record<ModelTier, string> = {
  // Cheaper + larger context than DeepSeek: MiMo V2 Flash 256k, ~$0.10/$0.30 per 1M tokens
  fast: "xiaomi/mimo-v2-flash",
  // Massive context vs Kimi, comparable elsewhere: Gemini 3 Flash ~$0.50/$3, 1M context
  medium: "google/gemini-3-flash-preview",
  // No real alternative at price: GLM-5 ~$0.80/$2.56 per 1M tokens, 202k context, rival to Claude Opus
  high: "z-ai/glm-5",
}

/**
 * Returns a ChatOpenAI-compatible model for the given tier.
 * Uses OpenRouter. Validates MODEL_PROVIDER_API_KEY via Zod and throws if missing.
 * Works with Bun (process.env).
 */
export function getModel(tier: ModelTier): ChatOpenAI {
  const { MODEL_PROVIDER_API_KEY, MODEL_PROVIDER_URL } = z
    .object({
      MODEL_PROVIDER_API_KEY: z
        .string()
        .min(1, "MODEL_PROVIDER_API_KEY is required for LLM operations"),
      MODEL_PROVIDER_URL: z
        .string()
        .url()
        .default("https://openrouter.ai/api/v1"),
    })
    .parse(process.env)

  return new ChatOpenAI({
    model: MODEL_IDS[tier],
    apiKey: MODEL_PROVIDER_API_KEY,
    configuration: {
      baseURL: MODEL_PROVIDER_URL,
    },
  })
}
