import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"

import {
  mergeModelParams,
  restrictModelParamsForProvider,
  type ModelParams,
} from "./modelParams.js"
import { modelParamsFromSpec, modelSpecBase } from "./parseModelSpec.js"
import { azureModelProvider } from "./providers/azureModelProvider.js"
import { bedrockModelProvider } from "./providers/bedrockModelProvider.js"
import { openAILikeModelProvider } from "./providers/openAILikeModelProvider.js"
import { openrouterModelProvider } from "./providers/openrouterModelProvider.js"
import type {
  ModelProviderKind,
  ModelTier,
  ProviderCallOpts,
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
    MODEL_FAST_NAME: z
      .string()
      .default("openai/gpt-5.5?reasoning.effort=low"),
    MODEL_MEDIUM_NAME: z
      .string()
      .default("openai/gpt-5.5?reasoning.effort=medium"),
    MODEL_HIGH_NAME: z
      .string()
      .default("openai/gpt-5.5?reasoning.effort=high"),
    MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
  })
  .superRefine((data, ctx) => {
    if (data.MODEL_PROVIDER === "azure") {
      if (!data.MODEL_PROVIDER_URL?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: `MODEL_PROVIDER_URL is required when MODEL_PROVIDER is ${data.MODEL_PROVIDER}`,
          path: ["MODEL_PROVIDER_URL"],
        })
      }
    }

    if (
      data.MODEL_PROVIDER !== "bedrock" &&
      !data.MODEL_PROVIDER_API_KEY?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        message: "MODEL_PROVIDER_API_KEY is required for LLM operations",
        path: ["MODEL_PROVIDER_API_KEY"],
      })
    }
  })

export type GetModelOptions = {
  temperature?: number
  /** When false, merges reasoning.effort=none over the tier model spec. */
  reasoning?: boolean
}

function uniqueModelChain(ids: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const base = modelSpecBase(id)
    if (!base) continue
    if (seen.has(base)) continue
    seen.add(base)
    out.push(base)
  }
  return out
}

function resolveChatBaseUrl(
  provider: ModelProviderKind,
  url: string | undefined,
): string {
  if (provider === "azure") {
    return url as string
  }
  return url?.trim() ? url : DEFAULT_OPENROUTER_BASE
}

function buildModelParamsForSpec(
  spec: string,
  reasoningOverride?: boolean,
): ModelParams | undefined {
  let params = modelParamsFromSpec(spec)
  if (reasoningOverride === false) {
    params = mergeModelParams(params, { reasoning: { effort: "none" } })
  }
  return Object.keys(params).length > 0 ? params : undefined
}

function tierModelSpec(
  tier: ModelTier,
  env: z.infer<typeof modelEnvSchema>,
): string {
  if (tier === "fast") return env.MODEL_FAST_NAME
  if (tier === "medium") return env.MODEL_MEDIUM_NAME
  return env.MODEL_HIGH_NAME
}

/**
 * Returns a LangChain chat model for the given tier.
 * Provider-specific chat and HTTP behavior lives under `providers/*ModelProvider.ts`.
 */
export function getModel(
  tier: ModelTier,
  options?: GetModelOptions,
): BaseChatModel {
  const env = modelEnvSchema.parse(process.env)
  const fast = env.MODEL_FAST_NAME
  const medium = env.MODEL_MEDIUM_NAME
  const high = env.MODEL_HIGH_NAME
  const primarySpec = tierModelSpec(tier, env)
  const rawModels =
    tier === "fast"
      ? [fast, medium, high]
      : tier === "medium"
        ? [medium, fast, high]
        : [high, medium, fast]
  const models = uniqueModelChain(rawModels)

  const modelParams = restrictModelParamsForProvider(
    buildModelParamsForSpec(primarySpec, options?.reasoning),
    env.MODEL_PROVIDER,
  )

  const callOpts: ProviderCallOpts = {
    models,
    modelParams,
    apiKey: env.MODEL_PROVIDER_API_KEY?.trim() ?? "",
    temperature: options?.temperature,
    env: {
      MODEL_PROVIDER_URL: env.MODEL_PROVIDER_URL,
      MODEL_BEDROCK_AWS_REGION: env.MODEL_BEDROCK_AWS_REGION,
      AWS_REGION: process.env.AWS_REGION,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    },
  }

  let providerFn = openAILikeModelProvider
  if (env.MODEL_PROVIDER === "bedrock") providerFn = bedrockModelProvider
  if (env.MODEL_PROVIDER === "azure") providerFn = azureModelProvider
  if (env.MODEL_PROVIDER === "openrouter") providerFn = openrouterModelProvider
  const { chat } = providerFn(callOpts)

  return chat
}

/**
 * Generates a 2000-dimensional embedding for text using an OpenAI-compatible
 * embeddings API (OpenRouter, OpenAI, Vertex, Bedrock, Ollama /v1/embeddings, etc.).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const env = modelEnvSchema.parse(process.env)
  const embedUrl = `${resolveChatBaseUrl(env.MODEL_PROVIDER, env.MODEL_PROVIDER_URL).replace(/\/$/, "")}/embeddings`
  const apiKey = env.MODEL_PROVIDER_API_KEY?.trim() ?? ""
  const embeddingModel = modelSpecBase(env.MODEL_EMBEDDING_NAME)

  const callOpts: ProviderCallOpts = {
    models: [embeddingModel],
    apiKey,
    env: {
      MODEL_PROVIDER_URL: env.MODEL_PROVIDER_URL,
      MODEL_BEDROCK_AWS_REGION: env.MODEL_BEDROCK_AWS_REGION,
      AWS_REGION: process.env.AWS_REGION,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    },
  }

  let providerFn = openAILikeModelProvider
  if (env.MODEL_PROVIDER === "bedrock") providerFn = bedrockModelProvider
  if (env.MODEL_PROVIDER === "azure") providerFn = azureModelProvider
  if (env.MODEL_PROVIDER === "openrouter") providerFn = openrouterModelProvider
  const providerResult = providerFn(callOpts)

  if (providerResult.embed) {
    return providerResult.embed(text)
  }

  const { fetch: doFetch } = providerResult

  const res = await doFetch(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: embeddingModel,
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
