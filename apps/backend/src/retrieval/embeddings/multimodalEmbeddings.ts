import { setTimeout as sleep } from "node:timers/promises"

import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import { gatewayCost } from "../../observability/gatewayCost.js"
import { withLlmGeneration } from "../../observability/llm-spans.js"
import { dropEmptyEnvValues } from "../services/modelTierSpecs.js"

/*
 * The embedding client of the knowledge plane (ADR-068 decisions 1, 5 and 7).
 * It sends text and image parts to the OpenRouter embeddings endpoint, and it
 * returns the full vectors. ClickHouse stores each vector as `Array(BFloat16)`
 * and calculates its binary form (`chunks.embedding_bits`) on the server.
 */

/**
 * The model settings of the knowledge plane. The evals of ADR-069 pick the
 * model, so all of its values are here. The model id is part of the projection
 * version (ADR-067): a change of the model id or the dimension makes all
 * stored vectors stale.
 */
export const multimodalEmbeddingConfig = {
  model: "google/gemini-embedding-2",
  /**
   * The one upstream provider (OpenRouter slug). No fallback (ADR-068
   * decision 7). Its endpoints must be on the OpenRouter ZDR list
   * (`GET /api/v1/endpoints/zdr`), because each request sets `zdr: true`.
   */
  upstreamProvider: "google-vertex",
  dimensions: 1024,
  /** The maximum number of inputs in one request. */
  batchSize: 16,
  /** The maximum number of attempts of one request (429 and 5xx retry). */
  maxAttempts: 5,
  /** The first backoff. Each retry doubles it, up to `maxBackoffMs`. */
  backoffMs: 500,
  maxBackoffMs: 8000,
}

type MultimodalEmbeddingConfig = typeof multimodalEmbeddingConfig

/** One input to embed. */
export type EmbeddingInput =
  /** A search query. It gets no context line: it is not part of a document. */
  | { kind: "query"; text: string }
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
      /** Sent as a text part with the image. A blank alt text sends the image only. */
      altText: string
    }

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

const envSchema = z.preprocess(
  dropEmptyEnvValues,
  z.object({
    MODEL_PROVIDER_API_KEY: z.string().trim().min(1),
    MODEL_PROVIDER_URL: z.string().url().optional(),
  }),
)

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

/** A 429 or 5xx answer. The message holds only the status, never the body. */
class RetryableStatusError extends Error {}

/**
 * Embed texts and images in one vector space. The result has the order of
 * `inputs`. Every request sets `provider.data_collection: "deny"` and
 * `provider.zdr: true`, and pins the upstream provider without fallback.
 */
export async function embedMultimodal(
  inputs: EmbeddingInput[],
  config: MultimodalEmbeddingConfig = multimodalEmbeddingConfig,
): Promise<number[][]> {
  if (inputs.length === 0) return []
  assertNotInOrgDbContext()
  const env = envSchema.parse(process.env)
  const base = env.MODEL_PROVIDER_URL ?? "https://openrouter.ai/api/v1"
  const url = `${base.replace(/\/$/, "")}/embeddings`

  const out: number[][] = []
  for (let start = 0; start < inputs.length; start += config.batchSize) {
    const batch = inputs.slice(start, start + config.batchSize)
    const body = JSON.stringify({
      model: config.model,
      input: batch.map((input) => ({ content: contentParts(input) })),
      dimensions: config.dimensions,
      encoding_format: "float",
      provider: {
        data_collection: "deny",
        order: [config.upstreamProvider],
        allow_fallbacks: false,
        zdr: true,
      },
    })
    for (let attempt = 1; ; attempt++) {
      try {
        const vectors = await embedRequest(batch, body, {
          url,
          apiKey: env.MODEL_PROVIDER_API_KEY,
          config,
        })
        out.push(...vectors)
        break
      } catch (err) {
        if (
          !(err instanceof RetryableStatusError) ||
          attempt >= config.maxAttempts
        )
          throw err
        await sleep(
          Math.min(config.backoffMs * 2 ** (attempt - 1), config.maxBackoffMs),
        )
      }
    }
  }
  return out
}

/** One HTTP request in one span. The span holds counts, never content. */
function embedRequest(
  batch: EmbeddingInput[],
  body: string,
  request: { url: string; apiKey: string; config: MultimodalEmbeddingConfig },
): Promise<number[][]> {
  const { config } = request
  let usage: { input?: number; cost?: number } | undefined
  return withLlmGeneration(
    {
      name: "embeddings.embedMultimodal",
      operation: "embeddings",
      model: config.model,
      provider: config.upstreamProvider,
      attributes: {
        "ctxpipe.embeddings.text_count": batch.filter((i) => i.kind !== "image")
          .length,
        "ctxpipe.embeddings.image_count": batch.filter(
          (i) => i.kind === "image",
        ).length,
      },
      resultAttributes: (vectors) => ({
        "ctxpipe.embeddings.count": vectors.length,
        "ctxpipe.embeddings.dimensions": config.dimensions,
      }),
      usageSoFar: () => usage,
    },
    async () => {
      const res = await fetch(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${request.apiKey}`,
        },
        body,
      })
      if (!res.ok) {
        // The provider can echo the input in the body. Keep it out of the
        // error, because the span status copies the error message.
        await res.arrayBuffer()
        const message = `Embedding request failed: HTTP ${res.status}`
        if (res.status === 429 || res.status >= 500)
          throw new RetryableStatusError(message)
        throw new Error(message)
      }
      // A parse error can quote the body, and the provider can echo the input
      // in it. Keep it out of the error, as for a failed status.
      const parsed = responseSchema.safeParse(
        await res.json().catch(() => undefined),
      )
      if (!parsed.success)
        throw new Error(
          "Embedding response is not valid JSON of the expected shape",
        )
      const data = parsed.data
      const input = data.usage?.prompt_tokens
      const cost = gatewayCost(data.usage)
      usage = {
        ...(input !== undefined ? { input } : {}),
        ...(cost !== undefined ? { cost } : {}),
      }
      return orderedVectors(data.data, batch.length, config.dimensions)
    },
  )
}

/** The content parts of one input (ADR-068 decision 5). */
function contentParts(input: EmbeddingInput): ContentPart[] {
  if (input.kind === "query") return [{ type: "text", text: input.text }]
  if (input.kind === "text") {
    // The one line of context: the document title and the chunk position.
    const title = input.documentTitle.replace(/\s+/g, " ").trim()
    const context = `${title} (part ${input.chunkIndex + 1} of ${input.chunkCount})`
    return [{ type: "text", text: `${context}\n\n${input.text}` }]
  }
  const dataUri = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`
  const parts: ContentPart[] = [
    { type: "image_url", image_url: { url: dataUri } },
  ]
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
  // The count and the unique indexes are checked, so each slot is set.
  return out.map((vector) => vector ?? [])
}
