import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import {
  embedTexts,
  textEmbeddingConfig,
} from "../../src/retrieval/embeddings/textEmbeddings.js"
import {
  type LayerCandidate,
  judgeLayer,
} from "../../src/retrieval/jev/layer-judge.js"
import { ZDR_PROVIDER } from "../../src/retrieval/services/modelProvider.js"
import { percentile } from "./metrics.js"
import type { ModelCalls } from "./model-calls.js"
import { withChangedBody } from "./probe.js"

/*
 * The latency of the model calls of a plane search (ADR-068), for a decision
 * of the CTO on the time budget. Each call goes only to a ZDR endpoint
 * (ADR-068 decision 7). The command sends fixed public texts only, one call
 * at a time, so that each latency is the latency of one request:
 *
 * - the query embedding of the plane through the real client, with no pin
 *   (as production sends it), and pinned to each ZDR provider of the model
 *   for the measurement only;
 * - a hedged query embedding: the request of the client to two providers
 *   at once, and the first answer;
 * - the query embedding of the other text embedding models with a ZDR
 *   endpoint, with no pin;
 * - Jev with the request of the layer judge (10 candidates);
 * - a request to OpenRouter that reaches no model, for the network time of
 *   this host.
 */

/** A search question of the evals, with no customer content. */
const QUERY = "How do we run the local development infrastructure?"

/** The latencies of one measure. */
type Measure = {
  name: string
  model: string
  /** The pinned providers, or "routing" when OpenRouter routes. */
  provider: string
  /** The price of 1M input tokens, from the endpoints of the model. */
  usdPer1MTokens: string
  samples: { ms: number; ok: boolean; servedBy?: string; error?: string }[]
}

const zdrListSchema = z.object({
  data: z.array(
    z.object({
      model_id: z.string(),
      tag: z.string(),
      quantization: z.string(),
    }),
  ),
})

const endpointsSchema = z.object({
  data: z.object({
    endpoints: z.array(
      z.object({ tag: z.string(), pricing: z.object({ prompt: z.string() }) }),
    ),
  }),
})

/** The provider slug of an endpoint tag (`nebius/bf16` → `nebius`). */
const slugOf = (tag: string) => tag.split("/")[0] ?? tag

/** The served provider of the last call that the recorder kept. */
function servedBy(calls: ModelCalls): string | undefined {
  const last = calls.records.at(-1)?.response
  if (!last) return undefined
  try {
    const provider = (JSON.parse(last) as { provider?: unknown }).provider
    return typeof provider === "string" ? provider : undefined
  } catch {
    return undefined
  }
}

/** Run `call` `runs` times, one after the other, and keep each latency. */
async function sample(
  runs: number,
  calls: ModelCalls,
  call: () => Promise<unknown>,
): Promise<Measure["samples"]> {
  const samples: Measure["samples"] = []
  for (let run = 0; run < runs && !calls.stopped; run++) {
    const started = performance.now()
    try {
      await call()
      samples.push({
        ms: performance.now() - started,
        ok: true,
        servedBy: servedBy(calls),
      })
    } catch (error) {
      samples.push({
        ms: performance.now() - started,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      })
    }
  }
  return samples
}

/** Made-up candidates of a layer, in the shape of the plane. */
const CANDIDATES: LayerCandidate[] = Array.from({ length: 10 }, (_, n) => ({
  id: `doc-${n}`,
  meta: {
    status: "current",
    sourceType: "docs",
    observedAt: "2026-11-01T00:00:00Z",
    validFrom: null,
    validTo: null,
    confidence: 0.8,
  },
  text: `Decision ${n}: the team runs service ${n} with Docker Compose profiles. The infra profile starts the database, the graph store and the collector. A developer runs one command to start it, and a second command to stop it.`,
}))

/**
 * Measure each call `runs` times, and write `latency.json` (each sample) and
 * `latency.md` (the table) to `out`. `calls` is installed in front of
 * `fetch`: the spend cap and the ZDR rule apply. `base` is the OpenRouter
 * base URL.
 */
export async function measureLatency(input: {
  out: string
  calls: ModelCalls
  base: string
  runs: number
}): Promise<Measure[]> {
  const { calls, runs } = input
  const base = input.base.replace(/\/$/, "")
  const getJson = async (path: string) => {
    const response = await fetch(`${base}${path}`)
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
    return response.json() as Promise<unknown>
  }
  const zdr = zdrListSchema.parse(await getJson("/endpoints/zdr")).data
  const prices = async (model: string) => {
    const { endpoints } = endpointsSchema.parse(
      await getJson(`/models/${model}/endpoints`),
    ).data
    return new Map(
      endpoints.map((endpoint) => [
        endpoint.tag,
        (Number(endpoint.pricing.prompt) * 1e6).toPrecision(3),
      ]),
    )
  }
  const measures: Measure[] = []
  const priceRange = (values: string[]) =>
    values.length === 0
      ? "?"
      : [...new Set(values)].sort((a, b) => Number(a) - Number(b)).join("–")

  // The network time of this host: a request that reaches no model.
  measures.push({
    name: "OpenRouter round trip (no model)",
    model: "—",
    provider: "—",
    usdPer1MTokens: "—",
    samples: await sample(10, calls, () =>
      getJson(`/models/${textEmbeddingConfig.model}/endpoints`),
    ),
  })

  // The query embedding of the plane through the real client.
  const qwen = textEmbeddingConfig.model
  const qwenPrices = await prices(qwen)
  const query = () => embedTexts([{ kind: "query", text: QUERY }])
  measures.push({
    name: "plane query embedding, production request",
    model: qwen,
    provider: "routing",
    usdPer1MTokens: priceRange([...qwenPrices.values()]),
    samples: await sample(runs, calls, query),
  })
  const qwenTags = zdr
    .filter((endpoint) => endpoint.model_id === qwen)
    .map((endpoint) => endpoint.tag)
  // One attempt, with the pin of the measurement: no fallback, no retry.
  const pinned = (slugs: string[]) =>
    withChangedBody(
      (body) => ({
        ...body,
        provider: { ...ZDR_PROVIDER, only: slugs, allow_fallbacks: false },
      }),
      () =>
        embedTexts([{ kind: "query", text: QUERY }], {
          ...textEmbeddingConfig,
          maxAttempts: 1,
        }),
    )
  for (const tag of qwenTags)
    measures.push({
      name: "plane query embedding, pinned",
      model: qwen,
      provider: tag,
      usdPer1MTokens: qwenPrices.get(tag) ?? "?",
      samples: await sample(runs, calls, () => pinned([slugOf(tag)])),
    })

  // The hedged request: the body of the client to two providers at once.
  const hedge = qwenTags.filter((tag) => !tag.includes("fp8")).slice(0, 2)
  if (hedge.length === 2) {
    let body: Record<string, unknown> = {}
    await withChangedBody(
      (captured) => {
        body = captured
        return captured
      },
      () => embedTexts([{ kind: "query", text: QUERY }]),
    )
    const send = (slug: string) =>
      fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.MODEL_PROVIDER_API_KEY ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          provider: { ...ZDR_PROVIDER, only: [slug], allow_fallbacks: false },
        }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await response.text()
        return slug
      })
    measures.push({
      name: "plane query embedding, hedged (first of two)",
      model: qwen,
      provider: hedge.join(" + "),
      usdPer1MTokens: `2 × ${priceRange(hedge.map((tag) => qwenPrices.get(tag) ?? "?"))}`,
      samples: await sample(runs, calls, () =>
        Promise.any(hedge.map((tag) => send(slugOf(tag)))),
      ),
    })
  }

  // The other text embedding models with a ZDR endpoint, with no pin.
  const others = [
    ...new Set(
      zdr
        .map((endpoint) => endpoint.model_id)
        .filter(
          (model) =>
            /embed/.test(model) && !/image/.test(model) && model !== qwen,
        ),
    ),
  ].sort()
  for (const model of others) {
    const modelPrices = await prices(model).catch(
      () => new Map<string, string>(),
    )
    const tags = zdr
      .filter((endpoint) => endpoint.model_id === model)
      .map((endpoint) => endpoint.tag)
    measures.push({
      name: "query embedding, other model",
      model,
      provider: `routing (${tags.join(", ")})`,
      usdPer1MTokens: priceRange(
        tags.flatMap((tag) => modelPrices.get(tag) ?? []),
      ),
      samples: await sample(runs, calls, async () => {
        const response = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.MODEL_PROVIDER_API_KEY ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: [QUERY],
            encoding_format: "float",
            provider: ZDR_PROVIDER,
          }),
        })
        const text = await response.text()
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      }),
    })
  }

  // Jev with the request of the layer judge.
  measures.push({
    name: "Jev, layer judge (10 candidates)",
    model: "typesafe/jev-1.14",
    provider: "routing",
    usdPer1MTokens: "—",
    samples: await sample(Math.min(runs, 30), calls, () =>
      judgeLayer({
        question: QUERY,
        intent: "how",
        candidates: CANDIDATES,
      }),
    ),
  })

  await mkdir(input.out, { recursive: true })
  await writeFile(
    join(input.out, "latency.json"),
    `${JSON.stringify({ measures, ...calls.summary() }, null, 2)}\n`,
  )
  await writeFile(join(input.out, "latency.md"), renderLatency(measures))
  return measures
}

/** The Markdown table of the measures. */
export function renderLatency(measures: readonly Measure[]): string {
  const ms = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value)} ms`
  const lines = [
    "# Latency of the model calls of a plane search",
    "",
    "Each call went to a ZDR endpoint, one at a time. A pin is for the measurement only.",
    "",
    "| Measure | Model | Provider | Calls | Errors | p50 | p95 | Max | $ / 1M tokens | Served by |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ]
  for (const measure of measures) {
    const ok = measure.samples.filter((sample) => sample.ok)
    const times = ok.map((sample) => sample.ms)
    const served = [
      ...new Set(ok.flatMap((sample) => sample.servedBy ?? [])),
    ].join(", ")
    lines.push(
      `| ${measure.name} | ${measure.model} | ${measure.provider} | ${measure.samples.length} | ${measure.samples.length - ok.length} | ${ms(percentile(times, 50))} | ${ms(percentile(times, 95))} | ${ms(times.length ? Math.max(...times) : null)} | ${measure.usdPer1MTokens} | ${served || "—"} |`,
    )
  }
  const errors = measures.flatMap((measure) =>
    measure.samples
      .filter((sample) => !sample.ok)
      .slice(0, 1)
      .map(
        (sample) => `- ${measure.model} (${measure.provider}): ${sample.error}`,
      ),
  )
  if (errors.length)
    lines.push("", "First error of each measure:", "", ...errors)
  return `${lines.join("\n")}\n`
}
