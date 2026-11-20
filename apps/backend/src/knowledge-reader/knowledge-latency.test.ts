import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { measureLatency } from "../../evals/knowledge/latency.js"
import { ModelCalls } from "../../evals/knowledge/model-calls.js"
import { useMswServer } from "../../test/msw.js"
import { textEmbeddingConfig } from "../retrieval/embeddings/textEmbeddings.js"

/*
 * The latency command of the knowledge eval harness, against msw in place of
 * OpenRouter: the measures, the pins of the measurement, the hedged request,
 * and the ZDR block on each model call.
 */

const BASE = "https://latency-gateway.test/api/v1"

/** The model, the provider block and the pin of each embedding request. */
const posted: {
  model: string
  provider: Record<string, unknown>
  pin: unknown
}[] = []

/** The endpoint tags of the pin of a provider block, or undefined. */
const pinOf = (provider: Record<string, unknown>) =>
  Object.entries(provider).find(([key]) => key === "only")?.[1]
let jevCalls = 0

useMswServer(
  http.get(`${BASE}/endpoints/zdr`, () =>
    HttpResponse.json({
      data: [
        {
          model_id: textEmbeddingConfig.model,
          provider_name: "Nebius",
          tag: "nebius/bf16",
          quantization: "bf16",
        },
        {
          model_id: textEmbeddingConfig.model,
          provider_name: "DeepInfra",
          tag: "deepinfra/us",
          quantization: "unknown",
        },
        // A low precision: pinned, but not in the hedge.
        {
          model_id: textEmbeddingConfig.model,
          provider_name: "SiliconFlow",
          tag: "siliconflow/fp8",
          quantization: "fp8",
        },
        {
          model_id: "openai/text-embedding-3-small",
          provider_name: "Azure",
          tag: "azure",
          // The list can give no quantization.
          quantization: null,
        },
        {
          model_id: "amazon/titan-embed-image-v1",
          provider_name: "Amazon Bedrock",
          tag: "amazon-bedrock",
          quantization: "unknown",
        },
        {
          model_id: "typesafe/jev-1.14",
          provider_name: "TypeSafe",
          tag: "typesafe",
          quantization: "unknown",
        },
      ],
    }),
  ),
  http.get(`${BASE}/models/:author/:slug/endpoints`, ({ params }) =>
    HttpResponse.json({
      data: {
        endpoints:
          params.author === "qwen"
            ? [
                { tag: "nebius/bf16", pricing: { prompt: "0.00000001" } },
                { tag: "deepinfra/us", pricing: { prompt: "0.00000001" } },
                { tag: "siliconflow/fp8", pricing: { prompt: "0.00000004" } },
              ]
            : [{ tag: "azure", pricing: { prompt: "0.00000002" } }],
      },
    }),
  ),
  http.post(`${BASE}/embeddings`, async ({ request }) => {
    const body = (await request.json()) as {
      model: string
      input: string[]
      provider: Record<string, unknown>
    }
    const pin = pinOf(body.provider) as string[] | undefined
    posted.push({ model: body.model, provider: body.provider, pin })
    return HttpResponse.json({
      data: body.input.map((_, index) => ({
        index,
        embedding: Array(textEmbeddingConfig.dimensions).fill(0.1),
      })),
      provider:
        pin?.[0] === "deepinfra/us"
          ? "DeepInfra"
          : pin?.[0] === "siliconflow/fp8"
            ? "SiliconFlow"
            : "Nebius",
      usage: { cost: 0.000001 },
    })
  }),
  http.post(
    "https://latency-gateway.test/api/alpha/decisions",
    async ({ request }) => {
      jevCalls += 1
      const body = (await request.json()) as {
        questions: Record<string, unknown>
        provider: Record<string, unknown>
      }
      expect(body.provider).toMatchObject({
        zdr: true,
        data_collection: "deny",
      })
      return HttpResponse.json({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key) => [
            key,
            { type: "noul", noul: 0.5 },
          ]),
        ),
        usage: { cost: 0.0001 },
      })
    },
  ),
)

describe("the latency command", () => {
  let out: string
  beforeEach(async () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_URL", BASE)
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    out = await mkdtemp(join(tmpdir(), "knowledge-latency-"))
    posted.length = 0
    jevCalls = 0
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(out, { recursive: true, force: true })
  })

  it("measures each call with ZDR, pins for the measurement only, and hedges two providers", async () => {
    const calls = new ModelCalls(BASE, 1, undefined, { addZdr: true })
    const restore = calls.install()
    try {
      const measures = await measureLatency({ out, calls, base: BASE, runs: 2 })
      expect(
        measures.map(({ name, model, provider, usdPer1MTokens, samples }) => ({
          name,
          model,
          provider,
          usdPer1MTokens,
          ok: samples.filter((sample) => sample.ok).length,
          servedBy: [...new Set(samples.map((sample) => sample.servedBy))],
        })),
      ).toEqual([
        {
          name: "OpenRouter round trip (no model)",
          model: "—",
          provider: "—",
          usdPer1MTokens: "—",
          ok: 10,
          servedBy: [undefined],
        },
        {
          name: "plane query embedding, production request",
          model: textEmbeddingConfig.model,
          provider: "routing",
          usdPer1MTokens: "0.0100–0.0400",
          ok: 2,
          servedBy: ["Nebius"],
        },
        {
          name: "plane query embedding, pinned",
          model: textEmbeddingConfig.model,
          provider: "nebius/bf16",
          usdPer1MTokens: "0.0100",
          ok: 2,
          servedBy: ["Nebius"],
        },
        {
          name: "plane query embedding, pinned",
          model: textEmbeddingConfig.model,
          provider: "deepinfra/us",
          usdPer1MTokens: "0.0100",
          ok: 2,
          servedBy: ["DeepInfra"],
        },
        {
          name: "plane query embedding, pinned",
          model: textEmbeddingConfig.model,
          provider: "siliconflow/fp8",
          usdPer1MTokens: "0.0400",
          ok: 2,
          servedBy: ["SiliconFlow"],
        },
        {
          name: "plane query embedding, hedged (first of two)",
          model: textEmbeddingConfig.model,
          provider: "nebius/bf16 + deepinfra/us",
          usdPer1MTokens: "2 × 0.0100",
          ok: 2,
          servedBy: expect.any(Array),
        },
        {
          name: "query embedding, other model",
          model: "openai/text-embedding-3-small",
          provider: "routing (azure)",
          usdPer1MTokens: "0.0200",
          ok: 2,
          servedBy: ["Nebius"],
        },
        {
          name: "Jev, layer judge (10 candidates)",
          model: "typesafe/jev-1.14",
          provider: "routing",
          usdPer1MTokens: "—",
          ok: 2,
          servedBy: [undefined],
        },
      ])
    } finally {
      restore()
    }
    // Each model call went only to a ZDR endpoint. A pin has no fallback,
    // and the production request has none.
    for (const { provider } of posted)
      expect(provider).toMatchObject({ zdr: true, data_collection: "deny" })
    expect(
      posted
        .filter(({ pin }) => pin)
        .map(({ pin, provider }) => [pin, provider.allow_fallbacks]),
    ).toEqual([
      [["nebius/bf16"], false],
      [["nebius/bf16"], false],
      [["deepinfra/us"], false],
      [["deepinfra/us"], false],
      [["siliconflow/fp8"], false],
      [["siliconflow/fp8"], false],
      // The hedge: two requests at once for each sample.
      [["nebius/bf16"], false],
      [["deepinfra/us"], false],
      [["nebius/bf16"], false],
      [["deepinfra/us"], false],
    ])
    // The production request: no pin, and the quantizations of the client.
    expect(
      posted
        .filter(({ model, pin }) => model === textEmbeddingConfig.model && !pin)
        .map(({ provider }) => provider.quantizations),
    ).toEqual([
      textEmbeddingConfig.quantizations,
      textEmbeddingConfig.quantizations,
    ])
    expect(jevCalls).toBe(2)
    const table = await readFile(join(out, "latency.md"), "utf8")
    expect(table).toContain(
      "| plane query embedding, pinned | qwen/qwen3-embedding-8b | deepinfra/us | 2 | 0 |",
    )
  })
})
