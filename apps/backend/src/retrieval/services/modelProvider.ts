import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { z } from "zod"
import { assertNotInOrgDbContext } from "../../db/client.js"
import {
  type LangfuseUsageDetails,
  withLangfuseGeneration,
} from "../../observability/langfuse.js"
import {
  type ModelParams,
  mergeModelParams,
  restrictModelParamsForProvider,
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

// An empty value is unset, as in `parseEnv`: Compose passes unset settings as "".
const modelEnvSchema = z.preprocess(
  (env) =>
    Object.fromEntries(
      Object.entries(env as Record<string, string | undefined>).filter(
        ([, value]) => value?.trim() !== "",
      ),
    ),
  z
    .object({
      MODEL_PROVIDER: modelProviderSchema.default("openai-like"),
      MODEL_PROVIDER_API_KEY: z.string().optional(),
      MODEL_PROVIDER_URL: z.string().url().optional(),
      MODEL_BEDROCK_AWS_REGION: z.string().optional(),
      MODEL_FAST_NAME: z
        .string()
        .default("openai/gpt-6-luna?reasoning.effort=high"),
      MODEL_MEDIUM_NAME: z
        .string()
        .default("openai/gpt-6-luna?reasoning.effort=xhigh"),
      MODEL_HIGH_NAME: z.string().default("xiaomi/mimo-v2.6-pro"),
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
    }),
)

export type GetModelOptions = {
  /** Fixed-purpose model selection; bypasses the configurable tier fallback chain. */
  model?: string
  temperature?: number
  /** When false, merges reasoning.effort=none over the tier model spec. */
  reasoning?: boolean
  /**
   * Whether the chat model uses streaming transport.
   * Defaults to `true` (conversation / MCP / UI). Pass `false` for
   * invoke-only ingestion to use non-stream Converse / chat completions.
   */
  streaming?: boolean
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

export function resolveChatBaseUrl(
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
  const primarySpec = options?.model ?? tierModelSpec(tier, env)
  const rawModels = options?.model
    ? [options.model]
    : tier === "fast"
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
    streaming: options?.streaming,
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

/** Max texts per OpenAI-compatible `/embeddings` request. */
export const EMBEDDING_BATCH_SIZE = 64
/** Bounded concurrency when the provider only exposes single-text `embed`. */
const EMBEDDING_SINGLE_CONCURRENCY = 8

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

function assertEmbeddingDims(embedding: number[], index?: number): number[] {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    const where = index === undefined ? "" : ` at index ${index}`
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions${where}, got ${embedding.length}`,
    )
  }
  return embedding
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

/** OpenAI-compatible `/embeddings` usage. Omit keys the provider did not send. */
function usageFromOpenAiCompatible(
  usage: unknown,
): LangfuseUsageDetails | undefined {
  if (usage == null || typeof usage !== "object") return undefined
  const record = usage as Record<string, unknown>
  const input = nonNegativeInt(record.prompt_tokens)
  const total = nonNegativeInt(record.total_tokens)
  if (input === undefined && total === undefined) {
    return undefined
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(total !== undefined ? { total } : {}),
  }
}

function addOptionalCount(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return left + right
}

function addUsage(
  left: LangfuseUsageDetails | undefined,
  right: LangfuseUsageDetails | undefined,
): LangfuseUsageDetails | undefined {
  if (!left) return right
  if (!right) return left
  const input = addOptionalCount(left.input, right.input)
  const total = addOptionalCount(left.total, right.total)
  if (input === undefined && total === undefined) {
    return undefined
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(total !== undefined ? { total } : {}),
  }
}

/**
 * Generates 2000-dimensional embeddings for many texts.
 * OpenAI-compatible providers receive `input: string[]` in chunks; providers that
 * only expose single-text `embed` (e.g. Bedrock) use bounded concurrency.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  assertNotInOrgDbContext()

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

  let usage: LangfuseUsageDetails | undefined
  return withLangfuseGeneration(
    {
      name: "modelProvider.generateEmbeddings",
      model: embeddingModel,
      input: {
        textCount: texts.length,
        totalCharacters: texts.reduce((sum, text) => sum + text.length, 0),
      },
      metadata: {
        provider: env.MODEL_PROVIDER,
        embeddingModel,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      summarizeOutput: (embeddings) => ({
        embeddingCount: embeddings.length,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      usageFromResult: () => usage,
    },
    async () => {
      const providerResult = providerFn(callOpts)

      if (providerResult.embed) {
        const embedOne = providerResult.embed
        return mapPool(texts, EMBEDDING_SINGLE_CONCURRENCY, async (text) =>
          assertEmbeddingDims(await embedOne(text)),
        )
      }

      const { fetch: doFetch } = providerResult
      const out = new Array<number[]>(texts.length)

      for (const [chunkOffset, chunk] of chunkArray(
        texts,
        EMBEDDING_BATCH_SIZE,
      ).entries()) {
        const baseIndex = chunkOffset * EMBEDDING_BATCH_SIZE
        const res = await doFetch(embedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: embeddingModel,
            input: chunk,
            dimensions: EMBEDDING_DIMENSIONS,
          }),
        })

        if (!res.ok) {
          throw new Error(`Embedding failed: ${res.status} ${await res.text()}`)
        }

        const data = (await res.json()) as {
          data?: { embedding?: number[]; index?: number }[]
          usage?: unknown
        }
        usage = addUsage(usage, usageFromOpenAiCompatible(data.usage))
        const rows = data.data ?? []
        if (rows.length !== chunk.length) {
          throw new Error(
            `Expected ${chunk.length} embeddings, got ${rows.length}`,
          )
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]
          if (!row) continue
          const localIndex = typeof row.index === "number" ? row.index : i
          const globalIndex = baseIndex + localIndex
          out[globalIndex] = assertEmbeddingDims(
            row.embedding ?? [],
            globalIndex,
          )
        }
      }

      for (let i = 0; i < out.length; i++) {
        if (!out[i]) {
          throw new Error(`Missing embedding at index ${i}`)
        }
      }
      return out
    },
  )
}

/**
 * Generates a 2000-dimensional embedding for text using an OpenAI-compatible
 * embeddings API (OpenRouter, OpenAI, Vertex, Bedrock, Ollama /v1/embeddings, etc.).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text])
  if (!embedding) {
    throw new Error("Expected 1 embedding, got 0")
  }
  return embedding
}
