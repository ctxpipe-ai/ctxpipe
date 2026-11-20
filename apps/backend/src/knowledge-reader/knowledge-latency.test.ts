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

/** The provider of each embedding request, by model. */
const posted: { model: string; provider: Record<string, unknown> }[] = []
let jevCalls = 0

useMswServer(
  http.get(`${BASE}/endpoints/zdr`, () =>
    HttpResponse.json({
      data: [
        {
          model_id: textEmbeddingConfig.model,
          tag: "nebius/bf16",
          quantization: "bf16",
        },
        {
          model_id: textEmbeddingConfig.model,
          tag: "deepinfra/us",
          quantization: "unknown",
        },
        {
          model_id: "openai/text-embedding-3-small",
          tag: "azure",
          quantization: "unknown",
        },
        {
          model_id: "amazon/titan-embed-image-v1",
          tag: "amazon-bedrock",
          quantization: "unknown",
        },
        {
          model_id: "typesafe/jev-1.14",
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
    posted.push({ model: body.model, provider: body.provider })
    const only = body.provider.only as string[] | undefined
    return HttpResponse.json({
      data: body.input.map((_, index) => ({
        index,
        embedding: Array(textEmbeddingConfig.dimensions).fill(0.1),
      })),
      provider: only?.[0] === "deepinfra" ? "DeepInfra" : "Nebius",
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
          usdPer1MTokens: "0.0100",
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
        .filter(({ provider }) => provider.only)
        .map(({ provider }) => [provider.only, provider.allow_fallbacks]),
    ).toEqual([
      [["nebius"], false],
      [["nebius"], false],
      [["deepinfra"], false],
      [["deepinfra"], false],
      // The hedge: two requests at once for each sample.
      ...Array.from({ length: 4 }, () => [expect.any(Array), false]),
    ])
    expect(
      posted.filter(
        ({ model, provider }) =>
          model === textEmbeddingConfig.model && !provider.only,
      ),
    ).toHaveLength(3)
    expect(jevCalls).toBe(2)
    const table = await readFile(join(out, "latency.md"), "utf8")
    expect(table).toContain(
      "| plane query embedding, pinned | qwen/qwen3-embedding-8b | deepinfra/us | 2 | 0 |",
    )
  })
})
