import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"

import { callAzure } from "./providers/callAzure.js"
import { callBedrock } from "./providers/callBedrock.js"
import { callOpenAILike } from "./providers/callOpenAILike.js"
import { callOpenrouter } from "./providers/callOpenrouter.js"
import type {
  ModelProviderKind,
  ModelTier,
  ProviderCallEnv,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providers/providerTypes.js"

export type { ModelProviderKind, ModelTier } from "./providers/providerTypes.js"

const EMBEDDING_DIMENSIONS = 2000

const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

const modelProviderSchema = z.enum([
  "openai-like",
  "openrouter",
  "azure",
  "bedrock",
])

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
      const hasIamEnv = Boolean(
        process.env.AWS_ACCESS_KEY_ID?.trim() &&
          process.env.AWS_SECRET_ACCESS_KEY?.trim(),
      )
      if (!hasKey && !hasIamEnv) {
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
      const hasIamEnv = Boolean(
        process.env.AWS_ACCESS_KEY_ID?.trim() &&
          process.env.AWS_SECRET_ACCESS_KEY?.trim(),
      )
      if (!hasKey && !hasIamEnv) {
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

function toProviderCallEnv(slice: {
  MODEL_PROVIDER_URL?: string | undefined
  MODEL_BEDROCK_AWS_REGION?: string | undefined
}): ProviderCallEnv {
  return {
    MODEL_PROVIDER_URL: slice.MODEL_PROVIDER_URL,
    MODEL_BEDROCK_AWS_REGION: slice.MODEL_BEDROCK_AWS_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  }
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

function resolveEmbeddingBaseUrl(
  provider: ModelProviderKind,
  modelProviderUrl: string | undefined,
  embeddingProviderUrl: string | undefined,
): string {
  const chatBase = resolveChatBaseUrl(provider, modelProviderUrl)
  return embeddingProviderUrl ?? `${chatBase.replace(/\/$/, "")}/embeddings`
}

function buildTierChatModels(
  tier: ModelTier,
  fast: string,
  medium: string,
  high: string,
): string[] {
  if (tier === "fast") return [fast, medium, high]
  if (tier === "medium") return [medium, fast, high]
  return [high, medium, fast]
}

type ProviderFn = (opts: ProviderCallOpts) => ProviderCallResult

function providerForKind(kind: ModelProviderKind): ProviderFn {
  let fn: ProviderFn = callOpenAILike
  if (kind === "bedrock") fn = callBedrock
  if (kind === "azure") fn = callAzure
  if (kind === "openrouter") fn = callOpenrouter
  return fn
}

/**
 * Returns a ChatOpenAI-compatible model for the given tier.
 * Provider-specific chat and HTTP behavior lives under `providers/call*.ts`.
 */
export function getModel(
  tier: ModelTier,
  options?: GetModelOptions,
): ChatOpenAI {
  const env = modelEnvSchema.parse(process.env)
  const models = buildTierChatModels(
    tier,
    env.MODEL_FAST_NAME,
    env.MODEL_MEDIUM_NAME,
    env.MODEL_HIGH_NAME,
  )

  const callOpts: ProviderCallOpts = {
    models,
    reasoning: tier !== "fast",
    apiKey: env.MODEL_PROVIDER_API_KEY?.trim() ?? "",
    env: toProviderCallEnv(env),
  }

  const { options: clientOptions } = providerForKind(env.MODEL_PROVIDER)(
    callOpts,
  )

  return new ChatOpenAI({
    ...clientOptions,
    temperature: options?.temperature,
  })
}

/**
 * Generates a 2000-dimensional embedding for text using an OpenAI-compatible
 * embeddings API (OpenRouter, OpenAI, Vertex, Bedrock, Ollama /v1/embeddings, etc.).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const env = embeddingEnvSchema.parse(process.env)
  const embedUrl = resolveEmbeddingBaseUrl(
    env.MODEL_PROVIDER,
    env.MODEL_PROVIDER_URL,
    env.MODEL_EMBEDDING_PROVIDER_URL,
  )

  const apiKey =
    env.MODEL_EMBEDDING_PROVIDER_API_KEY?.trim() ??
    env.MODEL_PROVIDER_API_KEY?.trim() ??
    ""

  const callOpts: ProviderCallOpts = {
    models: [env.MODEL_EMBEDDING_NAME],
    reasoning: false,
    apiKey,
    env: toProviderCallEnv(env),
  }

  const { fetch: doFetch } = providerForKind(env.MODEL_PROVIDER)(callOpts)

  const res = await doFetch(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
