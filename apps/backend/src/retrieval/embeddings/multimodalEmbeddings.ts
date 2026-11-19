import { setTimeout as sleep } from "node:timers/promises"

import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import { gatewayCost } from "../../observability/gatewayCost.js"
import { withLlmGeneration } from "../../observability/llm-spans.js"

/*
 * The embedding client of the knowledge plane (ADR-068 decisions 1, 5 and 7).
 * It sends text and image parts to the OpenRouter embeddings endpoint, and it
 * returns the two vector forms that ClickHouse stores for each chunk.
 */

/**
 * The model settings of the knowledge plane. The evals of ADR-069 pick the
 * model, so all of its values are here. The model id is part of the projection
 * version (ADR-067): a change of the model id or the dimension makes all
 * stored vectors stale.
 */
export const multimodalEmbeddingConfig = {
  model: "google/gemini-embedding-2",
  /** The one upstream provider (OpenRouter slug). No fallback (ADR-068 decision 7). */
  upstreamProvider: "google-vertex",
  /** A multiple of 8, so that the binary form fills whole bytes. */
  dimensions: 1024,
  /** The maximum number of inputs in one request. */
  batchSize: 16,
  /** The maximum number of attempts of one request (429 and 5xx retry). */
  maxAttempts: 5,
  /** The first backoff. Each retry doubles it, up to `maxBackoffMs`. */
  backoffMs: 500,
  maxBackoffMs: 8000,
}

export type MultimodalEmbeddingConfig = typeof multimodalEmbeddingConfig

/** One input to embed. */
export type EmbeddingInput =
  | {
      kind: "text"
      text: string
      /** The title of the document of the chunk. */
      documentTitle: string
      /** The 0-based position of the chunk in its document. */
      chunkIndex: number
      chunkCount: number
    }
  | {
      kind: "image"
      bytes: Uint8Array
      /** For example `image/png`. */
      mimeType: string
      altText: string
    }

/**
 * The two vector forms of ADR-068 decision 1.
 *
 * - `bfloat16`: one value for each dimension, as the BFloat16 bit pattern
 *   (the high 16 bits of the Float32, rounded to the nearest even value).
 *   For an `Array(BFloat16)` column in `RowBinary`, each value is 2 bytes
 *   little-endian, so the bytes of this array on a little-endian host are
 *   the wire form.
 * - `binary`: 1 bit for each dimension, `1` when the value is greater than 0.
 *   Dimension `i` is bit `7 - (i % 8)` of byte `floor(i / 8)` (most
 *   significant bit first). Store it in a `FixedString(dimensions / 8)`
 *   column; the Hamming distance is `bitCount(bitXor(a, b))`.
 */
export type Embedding = {
  bfloat16: Uint16Array
  binary: Uint8Array
}

const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

const envSchema = z.object({
  MODEL_PROVIDER_API_KEY: z.string().trim().min(1),
  MODEL_PROVIDER_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
})

const responseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative(),
    }),
  ),
  usage: z
    .object({ prompt_tokens: z.number().int().nonnegative().optional() })
    .passthrough()
    .optional(),
})

/**
 * Embed texts and images in one vector space. The result has the order of
 * `inputs`. Every request sets `provider.data_collection: "deny"` and pins
 * the upstream provider without fallback.
 */
export async function embedMultimodal(
  inputs: EmbeddingInput[],
  options: { signal?: AbortSignal; config?: MultimodalEmbeddingConfig } = {},
): Promise<Embedding[]> {
  if (inputs.length === 0) return []
  assertNotInOrgDbContext()
  const config = options.config ?? multimodalEmbeddingConfig
  if (config.dimensions % 8 !== 0) {
    throw new Error(
      `Embedding dimensions must be a multiple of 8, got ${config.dimensions}`,
    )
  }
  const env = envSchema.parse(process.env)
  const url = `${(env.MODEL_PROVIDER_URL ?? DEFAULT_OPENROUTER_BASE).replace(/\/$/, "")}/embeddings`

  const out: Embedding[] = []
  for (let start = 0; start < inputs.length; start += config.batchSize) {
    const batch = inputs.slice(start, start + config.batchSize)
    const vectors = await embedBatch(batch, {
      url,
      apiKey: env.MODEL_PROVIDER_API_KEY,
      config,
      signal: options.signal,
    })
    for (const vector of vectors) out.push(toEmbedding(vector))
  }
  return out
}

/** One request, with retries. One span; it holds counts, never content. */
async function embedBatch(
  batch: EmbeddingInput[],
  request: {
    url: string
    apiKey: string
    config: MultimodalEmbeddingConfig
    signal?: AbortSignal
  },
): Promise<number[][]> {
  const { config, signal } = request
  const body = JSON.stringify({
    model: config.model,
    input: batch.map((input) => ({ content: contentParts(input) })),
    dimensions: config.dimensions,
    encoding_format: "float",
    provider: {
      data_collection: "deny",
      order: [config.upstreamProvider],
      allow_fallbacks: false,
    },
  })
  let attempts = 0
  let usage: { input?: number; cost?: number } | undefined

  return withLlmGeneration(
    {
      name: "embeddings.embedMultimodal",
      operation: "embeddings",
      model: config.model,
      provider: config.upstreamProvider,
      attributes: {
        "ctxpipe.embeddings.text_count": batch.filter((i) => i.kind === "text")
          .length,
        "ctxpipe.embeddings.image_count": batch.filter(
          (i) => i.kind === "image",
        ).length,
      },
      resultAttributes: (vectors) => ({
        "ctxpipe.embeddings.count": vectors.length,
        "ctxpipe.embeddings.dimensions": config.dimensions,
        "ctxpipe.embeddings.attempts": attempts,
      }),
      usageSoFar: () => usage,
    },
    async () => {
      for (;;) {
        signal?.throwIfAborted()
        attempts += 1
        const res = await fetch(request.url, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${request.apiKey}`,
          },
          body,
        })
        const retryable = res.status === 429 || res.status >= 500
        if (retryable && attempts < config.maxAttempts) {
          await res.arrayBuffer()
          const delay = Math.min(
            config.backoffMs * 2 ** (attempts - 1),
            config.maxBackoffMs,
          )
          await sleep(delay, undefined, { signal })
          continue
        }
        if (!res.ok) {
          throw new Error(
            `Embedding request failed after ${attempts} attempt(s): ${res.status} ${await res.text()}`,
          )
        }
        const data = responseSchema.parse(await res.json())
        const input = data.usage?.prompt_tokens
        const cost = gatewayCost(data.usage)
        usage = {
          ...(input !== undefined ? { input } : {}),
          ...(cost !== undefined ? { cost } : {}),
        }
        return orderedVectors(data.data, batch.length, config.dimensions)
      }
    },
  )
}

/** The content parts of one input (ADR-068 decision 5). */
function contentParts(input: EmbeddingInput) {
  if (input.kind === "text") {
    // The one line of context: the document title and the chunk position.
    const context = `${input.documentTitle} (part ${input.chunkIndex + 1} of ${input.chunkCount})`
    return [{ type: "text", text: `${context}\n\n${input.text}` }]
  }
  const dataUri = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`
  const parts: unknown[] = [{ type: "image_url", image_url: { url: dataUri } }]
  if (input.altText.trim()) parts.push({ type: "text", text: input.altText })
  return parts
}

function orderedVectors(
  rows: { embedding: number[]; index: number }[],
  count: number,
  dimensions: number,
): number[][] {
  if (rows.length !== count) {
    throw new Error(`Expected ${count} embeddings, got ${rows.length}`)
  }
  const out = new Array<number[] | undefined>(count)
  for (const row of rows) {
    if (row.index >= count || out[row.index]) {
      throw new Error(`Unexpected embedding index ${row.index}`)
    }
    if (row.embedding.length !== dimensions) {
      throw new Error(
        `Expected ${dimensions} dimensions at index ${row.index}, got ${row.embedding.length}`,
      )
    }
    out[row.index] = row.embedding
  }
  return out as number[][]
}

function toEmbedding(vector: number[]): Embedding {
  const float32 = Float32Array.from(vector)
  const bits = new Uint32Array(float32.buffer)
  const bfloat16 = new Uint16Array(vector.length)
  const binary = new Uint8Array(vector.length / 8)
  for (let i = 0; i < vector.length; i++) {
    const value = float32[i] as number
    const u = bits[i] as number
    bfloat16[i] = Number.isNaN(value)
      ? 0x7fc0
      : (u + 0x7fff + ((u >>> 16) & 1)) >>> 16
    if (value > 0)
      binary[i >> 3] = (binary[i >> 3] as number) | (0x80 >> (i & 7))
  }
  return { bfloat16, binary }
}
