import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import {
  embedQuery,
  textEmbeddingConfig,
} from "../../src/retrieval/embeddings/textEmbeddings.js"
import {
  decisionModelSettings,
  JEV_MODEL,
} from "../../src/retrieval/jev/decision-model.js"
import { judgeLayer } from "../../src/retrieval/jev/layer-judge.js"
import {
  isAllowedProvider,
  openRouterProvider,
} from "../../src/retrieval/services/openRouterProvider.js"
import { scrubForModel } from "../../src/retrieval/services/scrubForModel.js"
import { percentile } from "./metrics.js"
import type { ModelCalls } from "./model-calls.js"
import { readZdrList, withChangedBody } from "./probe.js"

/*
 * The latency of the model calls of a plane search (ADR-068), for a decision
 * of the CTO on the time budget. Each call goes only to a ZDR endpoint of
 * an allowed provider (ADR-070). The command sends fixed public texts only, one
 * sample at a time, so that each latency is the latency of one request:
 *
 * - the query embedding of the plane through the real client, with no pin
 *   (as production sends it), and pinned to each ZDR endpoint of the model
 *   for the measurement only;
 * - the query embedding of the other text embedding models with a ZDR
 *   endpoint, with no pin, and pinned to each of its ZDR endpoints;
 * - Jev with the request of the layer judge (10 candidates), through the
 *   real client: a call with no answer after 700 ms sends a second copy of
 *   its request, as in production;
 * - a request to OpenRouter that reaches no model, for the network time of
 *   this host.
 */

/** A search question of the evals, with no customer content. */
const QUERY = "How do we run the local development infrastructure?"

/** The latencies of one measure. */
type Measure = {
  name: string
  model: string
  /** The pinned endpoints, or "routing" when OpenRouter routes. */
  provider: string
  /** The price of 1M input tokens, from the endpoints of the model. */
  usdPer1MTokens: string
  samples: { ms: number; ok: boolean; servedBy?: string; error?: string }[]
}

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

/**
 * Run `call` `runs` times, one after the other, and keep each latency: the
 * time until `call` gives its answer.
 */
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
  // Only the endpoints of the allowed providers (ADR-070).
  const zdr = (await readZdrList(base)).filter((endpoint) =>
    isAllowedProvider(endpoint.tag),
  )
  const tagsOf = (model: string) =>
    zdr
      .filter((endpoint) => endpoint.model_id === model)
      .map((endpoint) => endpoint.tag)
  /** The price of 1M input tokens of each endpoint tag of `model`. */
  const pricesOf = async (model: string) => {
    const { endpoints } = z
      .object({
        data: z.object({
          endpoints: z.array(
            z.object({
              tag: z.string(),
              pricing: z.object({ prompt: z.string() }),
            }),
          ),
        }),
      })
      .parse(await getJson(`/models/${model}/endpoints`)).data
    const prices = new Map(
      endpoints.map((endpoint) => [
        endpoint.tag,
        (Number(endpoint.pricing.prompt) * 1e6).toPrecision(3),
      ]),
    )
    return (tags: readonly string[]) => {
      const values = [
        ...new Set(tags.flatMap((tag) => prices.get(tag) ?? [])),
      ].sort((a, b) => Number(a) - Number(b))
      return values.length ? values.join("–") : "?"
    }
  }
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.MODEL_PROVIDER_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await scrubForModel(body)),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
  }
  /**
   * The provider block of the measurement: the provider block of ADR-070,
   * and one endpoint tag with no fallback.
   */
  const pin = (tag: string) => ({
    ...openRouterProvider(),
    only: [tag],
    allow_fallbacks: false,
  })
  const measures: Measure[] = []

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
  const plane = textEmbeddingConfig.model
  const planeTags = tagsOf(plane)
  const planePrice = await pricesOf(plane)
  measures.push({
    name: "plane query embedding, production request",
    model: plane,
    provider: "routing",
    usdPer1MTokens: planePrice(planeTags),
    samples: await sample(runs, calls, () => embedQuery(QUERY)),
  })
  for (const tag of planeTags)
    measures.push({
      name: "plane query embedding, pinned",
      model: plane,
      provider: tag,
      usdPer1MTokens: planePrice([tag]),
      // The query path makes one attempt, so that an error counts.
      samples: await sample(runs, calls, () =>
        withChangedBody(
          (body) => ({ ...body, provider: pin(tag) }),
          () => embedQuery(QUERY),
        ),
      ),
    })

  // The other text embedding models with a ZDR endpoint.
  const others = [
    ...new Set(
      zdr
        .map((endpoint) => endpoint.model_id)
        .filter(
          (model) =>
            /embed/.test(model) && !/image/.test(model) && model !== plane,
        ),
    ),
  ].sort()
  for (const model of others) {
    const tags = tagsOf(model)
    const price = await pricesOf(model).catch(() => () => "?")
    const body = { model, input: [QUERY], encoding_format: "float" }
    measures.push({
      name: "query embedding, other model",
      model,
      provider: `routing (${tags.join(", ")})`,
      usdPer1MTokens: price(tags),
      samples: await sample(runs, calls, () =>
        post({ ...body, provider: openRouterProvider() }),
      ),
    })
    for (const tag of tags)
      measures.push({
        name: "query embedding, other model, pinned",
        model,
        provider: tag,
        usdPer1MTokens: price([tag]),
        samples: await sample(runs, calls, () =>
          post({ ...body, provider: pin(tag) }),
        ),
      })
  }

  // The decision model of the settings with the request of the layer judge:
  // 10 made-up candidates.
  measures.push({
    name: "Decision model, layer judge (10 candidates)",
    model: decisionModelSettings()?.model ?? JEV_MODEL,
    provider: "routing",
    usdPer1MTokens: "—",
    samples: await sample(Math.min(runs, 30), calls, () =>
      judgeLayer({
        question: QUERY,
        intent: "how",
        candidates: Array.from({ length: 10 }, (_, n) => ({
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
        })),
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
function renderLatency(measures: readonly Measure[]): string {
  const ms = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value)} ms`
  const lines = [
    "# Latency of the model calls of a plane search",
    "",
    "Each call went to a ZDR endpoint, one sample at a time. A pin is for the measurement only.",
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
    lines.push("", "The first error of each measure:", "", ...errors)
  return `${lines.join("\n")}\n`
}
