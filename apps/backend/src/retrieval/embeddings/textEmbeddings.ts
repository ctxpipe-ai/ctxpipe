import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import { mapWithConcurrency } from "../../lib/mapWithConcurrency.js"
import {
  isRetryableFetchFailure,
  TransientHttpError,
} from "../../lib/withTransientHttpRetry.js"
import { gatewayCost } from "../../observability/gatewayCost.js"
import { gatewayRoutingError } from "../../observability/gatewayError.js"
import { withLlmGeneration } from "../../observability/llm-spans.js"
import { openRouterSettings } from "../services/modelProvider.js"
import { openRouterProvider } from "../services/openRouterProvider.js"
import { scrubForModel } from "../services/scrubForModel.js"

/*
 * The embedding client of the knowledge plane (ADR-068 decisions 1, 5 and 7).
 * One text model embeds every chunk and every search question in one vector
 * space. The ingest path (`embedTexts`) sends the chunks in batches to the
 * OpenRouter embeddings endpoint, with retries. The query path
 * (`embedQuery`) sends one question, routed by latency, in one attempt. Both
 * return the full vectors. ClickHouse stores each vector as
 * `Array(BFloat16)` and calculates its binary form (`chunks.embedding_bits`)
 * on the server. An image gets no vector: ingest writes a text file beside
 * it (ADR-068 decision 6).
 */

/**
 * A failure of the embedding call: an error status (`status`), an answer of
 * the wrong shape, or model settings that cannot reach OpenRouter. The
 * client throws it for each failure that does not retry. A 429, a 5xx and a
 * network error are `TransientHttpError`s and fetch errors, so that
 * `embedTexts` retries them. The query path does not retry: the plane
 * reader gives such an error as an `EmbeddingError` with the status, when
 * there is one. The message holds no input text.
 */
export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError"
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * The model settings of the knowledge plane. The evals of ADR-069 pick the
 * model, so all of its values are here. The model and the dimension are part
 * of the projection version (ADR-067): a change of one of them makes all
 * stored vectors stale.
 */
export const textEmbeddingConfig = {
  /**
   * OpenAI text-embedding-3-large (ADR-068 decision 5). It takes
   * `dimensions` and gives a shortened vector of that length.
   */
  model: "openai/text-embedding-3-large",
  dimensions: 1024,
  /**
   * The most inputs in one request: the limit of the OpenAI and Azure
   * embeddings APIs (2048).
   */
  maxBatchInputs: 2048,
  /*
   * The OpenAI and Azure embeddings APIs take at most 300,000 tokens in one
   * request, summed over its inputs, and 8192 tokens in one input. The
   * client has no tokenizer. A token of the model is at least one byte of
   * UTF-8, so the client limits the UTF-8 bytes to these numbers.
   */
  /** The most UTF-8 bytes in one request, summed over its inputs. */
  maxBatchBytes: 300_000,
  /**
   * The most UTF-8 bytes of one input. A longer input loses its end. A chunk
   * has at most 2048 characters, so only a chunk with a very long title or
   * many 4-byte characters can be longer.
   */
  maxInputBytes: 8192,
  /** The most requests in flight of one `embedTexts` call. */
  concurrency: 4,
  /**
   * The maximum number of attempts of one ingest request (429, 5xx and
   * network errors retry). A query has one attempt (`embedQuery`).
   */
  maxAttempts: 5,
  /** The first backoff. Each retry doubles it, up to `maxBackoffMs`. */
  backoffMs: 500,
  maxBackoffMs: 8000,
}

type TextEmbeddingConfig = typeof textEmbeddingConfig

/** One chunk of a document to embed. */
export type EmbeddingInput = {
  text: string
  /** The title of the document of the chunk. */
  documentTitle: string
  /** The 0-based position of the chunk in its document. */
  chunkIndex: number
  chunkCount: number
}

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
 * The key of the vector of `input`: the SHA-256 (hex) of the model, the
 * dimensions and the text that the request sends. Two inputs with the same
 * key get the same vector, so the writer reuses a stored vector of the key
 * (ADR-067 decision 5). A change of the model or the dimensions changes each
 * key. The request sends the scrubbed text (ADR-072), so the input must be
 * scrubbed first (`scrubForModel`): then a new scrubber gives a new
 * key for each text that it changes.
 */
export function embeddingKey(
  input: EmbeddingInput,
  config: TextEmbeddingConfig = textEmbeddingConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.model,
        config.dimensions,
        chunkText(input, config),
      ]),
    )
    .digest("hex")
}

/**
 * Embed the chunks of documents in the one vector space of the knowledge
 * plane (the ingest path). The result has the order of `inputs`. One request
 * holds as many inputs as `maxBatchInputs` and `maxBatchBytes` allow, and
 * at most `concurrency` requests are in flight. Every request sets
 * `provider.data_collection: "deny"` and `provider.zdr: true`, so OpenRouter
 * routes it only to a ZDR endpoint. A 429, a 5xx and a network error retry
 * with backoff, up to `maxAttempts`.
 * `onRequest` is called before each HTTP request, also before each retry.
 */
export async function embedTexts(
  rawInputs: EmbeddingInput[],
  config: TextEmbeddingConfig = textEmbeddingConfig,
  onRequest?: () => void,
): Promise<number[][]> {
  if (rawInputs.length === 0) return []
  // Scrubbed whole, before `chunkText` cuts an input to `maxInputBytes`: a
  // cut can remove the end of a secret, and then no rule finds it.
  const inputs = await scrubForModel(rawInputs)

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    for (let attempt = 1; ; attempt++) {
      try {
        onRequest?.()
        return await embedRequest(texts, config)
      } catch (err) {
        // A 429, a 5xx and a network error of fetch (no answer) retry. The
        // message of a network error holds no input text.
        if (!isRetryableFetchFailure(err) || attempt >= config.maxAttempts)
          throw err
        await sleep(
          Math.min(config.backoffMs * 2 ** (attempt - 1), config.maxBackoffMs),
        )
      }
    }
  }

  // A batch closes before the input that would put it over a limit.
  const batches: string[][] = []
  let bytes = 0
  for (const text of inputs.map((input) => chunkText(input, config))) {
    const size = Buffer.byteLength(text, "utf8")
    const last = batches.at(-1)
    if (
      last &&
      last.length < config.maxBatchInputs &&
      bytes + size <= config.maxBatchBytes
    ) {
      last.push(text)
      bytes += size
    } else {
      batches.push([text])
      bytes = size
    }
  }
  // After a failure, no new request starts.
  return (
    await mapWithConcurrency(batches, config.concurrency, embedBatch)
  ).flat()
}

/**
 * Embed one search question (the query path), as it is, up to
 * `maxInputBytes`: the model needs no instruction line. The request has the provider block of `embedTexts`, and
 * it asks OpenRouter to sort the ZDR endpoints by latency, with its default
 * fallback (ADR-068 decision 7). The query has a time budget, so a failure
 * does not retry: the search returns partial.
 */
export async function embedQuery(
  text: string,
  config: TextEmbeddingConfig = textEmbeddingConfig,
): Promise<number[]> {
  // Scrubbed whole before the cut, as in `embedTexts`.
  const [vector] = await embedRequest(
    [fitInput(await scrubForModel(text), config.maxInputBytes)],
    config,
    "latency",
  )
  if (!vector)
    throw new EmbeddingError("The embedding endpoint returned no vector")
  return vector
}

/**
 * One HTTP request with `texts`, in one span. The provider block has the ZDR
 * fields, and `sort` when it is set. The span holds counts, never content.
 */
function embedRequest(
  texts: string[],
  config: TextEmbeddingConfig,
  sort?: "latency",
): Promise<number[][]> {
  assertNotInOrgDbContext()
  // The model and the provider block are of OpenRouter. A deployment whose
  // model settings do not point at OpenRouter sends no content to it.
  const settings = openRouterSettings()
  if (!settings)
    throw new EmbeddingError(
      "The knowledge embeddings need MODEL_PROVIDER openrouter or openai-like, an OpenRouter MODEL_PROVIDER_URL, and MODEL_PROVIDER_API_KEY.",
    )
  const count = texts.length
  let usage: { input?: number; cost?: number } | undefined
  return withLlmGeneration(
    {
      name: "embeddings.embedTexts",
      operation: "embeddings",
      model: config.model,
      provider: "openrouter",
      attributes: { "ctxpipe.embeddings.text_count": count },
      resultAttributes: () => ({
        "ctxpipe.embeddings.count": count,
        "ctxpipe.embeddings.dimensions": config.dimensions,
      }),
      usageSoFar: () => usage,
    },
    async () => {
      const res = await fetch(
        `${settings.base.replace(/\/$/, "")}/embeddings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            input: texts,
            dimensions: config.dimensions,
            encoding_format: "float",
            provider: {
              ...openRouterProvider(),
              ...(sort ? { sort } : {}),
            },
          }),
        },
      )
      if (!res.ok) {
        // The provider can echo the input in the body. Keep it out of the
        // error, because the span status copies the error message. Only a
        // fixed routing message of the gateway stays.
        const routing = gatewayRoutingError(await res.text(), config.model)
        const message = `Embedding request failed: HTTP ${res.status}${routing ? `: ${routing}` : ""}`
        if (res.status === 429 || res.status >= 500)
          // The message holds only the status, never the body.
          throw new TransientHttpError(message, res.status)
        throw new EmbeddingError(message, res.status)
      }
      // A parse error can quote the body, and the provider can echo the input
      // in it. Keep it out of the error, as for a failed status.
      const parsed = responseSchema.safeParse(
        await res.json().catch(() => undefined),
      )
      if (!parsed.success)
        throw new EmbeddingError(
          "Embedding response is not valid JSON of the expected shape",
        )
      const data = parsed.data
      const input = data.usage?.prompt_tokens
      const cost = gatewayCost(data.usage)
      usage = {
        ...(input !== undefined ? { input } : {}),
        ...(cost !== undefined ? { cost } : {}),
      }
      return vectorsInOrder(data.data, count, config.dimensions)
    },
  )
}

/**
 * The text of one chunk: one line of context, the document title and the
 * chunk position (ADR-068 decision 5), up to `maxInputBytes`.
 */
function chunkText(input: EmbeddingInput, config: TextEmbeddingConfig): string {
  const title = input.documentTitle.replace(/\s+/g, " ").trim()
  const context = `${title} (part ${input.chunkIndex + 1} of ${input.chunkCount})`
  return fitInput(`${context}\n\n${input.text}`, config.maxInputBytes)
}

/** The start of `text` with at most `maxBytes` bytes of UTF-8, at a code point. */
function fitInput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const point of text) {
    bytes += Buffer.byteLength(point, "utf8")
    if (bytes > maxBytes) break
    end += point.length
  }
  return text.slice(0, end)
}

/**
 * The vectors of an answer to a request with `count` inputs, in the order of
 * the inputs. The answer can give them in another order: `index` says which
 * input each vector belongs to.
 */
function vectorsInOrder(
  rows: { embedding: number[]; index: number }[],
  count: number,
  dimensions: number,
): number[][] {
  if (rows.length !== count)
    throw new EmbeddingError(`Expected ${count} embeddings, got ${rows.length}`)
  const vectors = new Array<number[] | undefined>(count)
  for (const row of rows) {
    if (row.index >= count || vectors[row.index])
      throw new EmbeddingError(`Unexpected embedding index ${row.index}`)
    if (row.embedding.length !== dimensions)
      throw new EmbeddingError(
        `Expected ${dimensions} dimensions at index ${row.index}, got ${row.embedding.length}`,
      )
    vectors[row.index] = row.embedding
  }
  return vectors.map((vector) => vector ?? [])
}
