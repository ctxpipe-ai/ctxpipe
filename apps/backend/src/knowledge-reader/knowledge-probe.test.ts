import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { ModelCalls } from "../../evals/knowledge/model-calls.js"
import { probe, probeControls } from "../../evals/knowledge/probe.js"
import { useMswServer } from "../../test/msw.js"

/*
 * The live provider probe (`cli.ts probe`) against a fake OpenRouter (msw).
 * The probe sends its requests through the real Jev and embedding clients;
 * these tests check the requests, the pass and fail rules, the evidence and
 * the spend cap.
 */

const BASE = "https://probe-gateway.test/api/v1"
const DECISIONS = "https://probe-gateway.test/api/alpha/decisions"
const EMBEDDINGS = `${BASE}/embeddings`

const server = useMswServer()

let out: string
beforeEach(async () => {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_URL", BASE)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  out = await mkdtemp(join(tmpdir(), "knowledge-probe-"))
})
afterEach(async () => {
  await rm(out, { recursive: true, force: true })
})

const providerSchema = z.object({
  data_collection: z.string(),
  zdr: z.boolean(),
  quantizations: z.array(z.string()).optional(),
})
const decisionSchema = z.object({
  model: z.string(),
  state: z.array(z.unknown()),
  questions: z.record(z.string(), z.unknown()),
  provider: providerSchema,
})
const embeddingSchema = z.object({
  model: z.string(),
  dimensions: z.number().optional(),
  input: z.array(z.string()),
  encoding_format: z.string(),
  provider: providerSchema,
})

/** The Decisions endpoints of the fake catalog, as on OpenRouter. */
const ENDPOINTS: Record<string, { name: string; zdr: boolean }> = {
  "typesafe/jev-1.14": { name: "TypeSafe", zdr: true },
  "openai/gpt-6-luna-decisions": { name: "OpenAI", zdr: false },
}

/** The fake OpenRouter ZDR list (`GET /api/v1/endpoints/zdr`). */
const ZDR_LIST = [
  ["typesafe/jev-1.14", "TypeSafe", "unknown"],
  ["qwen/qwen3-embedding-8b", "Nebius", "bf16"],
  ["qwen/qwen3-embedding-8b", "DeepInfra", "unknown"],
  ["qwen/qwen3-embedding-8b", "SiliconFlow", "fp8"],
].map(([model_id, provider_name, quantization]) => ({
  model_id,
  provider_name,
  quantization,
}))

/**
 * A gateway that routes Decisions requests like OpenRouter: with `zdr: true`
 * only to a ZDR endpoint. With
 * `enforcesZdr: false`, it ignores `zdr`. `refusal` replaces the answer to a
 * request with `zdr: true` to the non-ZDR model. Embedding requests route
 * the same way: `openai/text-embedding-ada-002` has no ZDR endpoint. A
 * request with more than `maxInputs` embedding inputs finds no endpoint.
 */
function gateway(options: {
  enforcesZdr: boolean
  jevName?: string
  embeddingName?: string
  dimensions?: number
  refusal?: { status: number; message: string }
  /** The most embedding inputs that one request may hold. */
  maxInputs?: number
}) {
  const bodies = {
    decisions: [] as z.infer<typeof decisionSchema>[],
    embeddings: [] as z.infer<typeof embeddingSchema>[],
  }
  server.use(
    http.get(`${BASE}/endpoints/zdr`, () =>
      HttpResponse.json({ data: ZDR_LIST }),
    ),
    http.post(DECISIONS, async ({ request }) => {
      const body = decisionSchema.parse(await request.json())
      bodies.decisions.push(body)
      const endpoint = ENDPOINTS[body.model]
      if (options.refusal && body.provider.zdr && !endpoint?.zdr)
        return HttpResponse.json(
          { error: { message: options.refusal.message } },
          { status: options.refusal.status },
        )
      if (
        !endpoint ||
        (options.enforcesZdr && body.provider.zdr && !endpoint.zdr)
      )
        return HttpResponse.json(
          {
            error: {
              message: "No endpoints found matching your data policy.",
            },
          },
          { status: 404 },
        )
      return HttpResponse.json({
        answers: { sky: { type: "noul", noul: 0.9 } },
        provider:
          body.model === "typesafe/jev-1.14"
            ? (options.jevName ?? endpoint.name)
            : endpoint.name,
        usage: { cost: 0.0001 },
      })
    }),
    http.post(EMBEDDINGS, async ({ request }) => {
      const body = embeddingSchema.parse(await request.json())
      bodies.embeddings.push(body)
      if (
        body.input.length > (options.maxInputs ?? Infinity) ||
        (options.enforcesZdr &&
          body.provider.zdr &&
          body.model === "openai/text-embedding-ada-002")
      )
        return HttpResponse.json(
          {
            error: {
              code: 404,
              message:
                "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
            },
          },
          { status: 404 },
        )
      return HttpResponse.json({
        data: body.input.map((_, index) => ({
          embedding: Array.from(
            { length: options.dimensions ?? 1024 },
            () => 0.1,
          ),
          index,
        })),
        provider: options.embeddingName ?? "Nebius",
        usage: { prompt_tokens: 4, cost: 0.00001 },
      })
    }),
  )
  return bodies
}

const resultSchema = z.object({
  spentUsd: z.number(),
  stopped: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      pass: z.boolean(),
      status: z.number().nullable(),
      provider: z.string().nullable(),
      error: z.string().nullable(),
      expects: z.string(),
    }),
  ),
})
const readResult = async () =>
  resultSchema.parse(
    JSON.parse(await readFile(join(out, "probe.json"), "utf8")),
  )
const run = (capUsd: number) =>
  probe({ out, calls: new ModelCalls(BASE, capUsd), capUsd, base: BASE })
const passes = async () =>
  Object.fromEntries(
    (await readResult()).checks.map((check) => [check.name, check.pass]),
  )

describe("the provider probe", () => {
  it("passes each check when the gateway enforces the provider settings", async () => {
    const bodies = gateway({ enforcesZdr: true })

    expect(await run(0.05)).toBe(0)

    const result = await readResult()
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: "decisions-zdr-provider",
        pass: true,
        status: 200,
        provider: "TypeSafe",
        error: null,
      }),
      expect.objectContaining({
        name: "decisions-control-without-zdr",
        pass: true,
        status: 200,
        provider: "OpenAI",
      }),
      expect.objectContaining({
        name: "decisions-refused-without-zdr-endpoint",
        pass: true,
        status: 404,
        error:
          "Jev answered HTTP 404: No endpoints found matching your data policy.",
      }),
      expect.objectContaining({
        name: "embedding-query",
        pass: true,
        status: 200,
        provider: "Nebius",
      }),
      expect.objectContaining({ name: "embedding-text-batch", pass: true }),
      expect.objectContaining({
        name: "embedding-control-without-zdr",
        pass: true,
        status: 200,
      }),
      expect.objectContaining({
        name: "embedding-refused-without-zdr-endpoint",
        pass: true,
        status: 404,
      }),
    ])
    expect(result.stopped).toBe(false)
    expect(await readFile(join(out, "probe.md"), "utf8")).toContain(
      "| decisions-zdr-provider | pass | 200 | TypeSafe |",
    )

    // The control and the refused request are the request of the real
    // client: only the model and `zdr` change. No request pins a provider.
    const [served, control, refused] = bodies.decisions
    expect(served?.provider).toEqual({ data_collection: "deny", zdr: true })
    const nonZdr = {
      ...served,
      model: "openai/gpt-6-luna-decisions",
      state: ["The sky is green."],
    }
    expect(control).toEqual({
      ...nonZdr,
      provider: { data_collection: "deny", zdr: false },
    })
    expect(refused).toEqual(nonZdr)

    // The question goes with the instruction line of the model, only to a
    // ZDR endpoint at an allowed quantization.
    expect(bodies.embeddings[0]).toEqual({
      model: "qwen/qwen3-embedding-8b",
      dimensions: 1024,
      encoding_format: "float",
      input: [
        expect.stringMatching(
          /^Instruct: .+\nQuery:Which squares of the checkerboard are red\?$/,
        ),
      ],
      provider: {
        data_collection: "deny",
        zdr: true,
        quantizations: ["bf16", "fp16", "fp32", "unknown"],
      },
    })
    // The batch is one request with 64 document chunks, each with the
    // context line of the projection.
    expect(bodies.embeddings).toHaveLength(4)
    expect(bodies.embeddings[1]?.input).toHaveLength(64)
    expect(bodies.embeddings[1]?.input.at(-1)).toBe(
      "Checkerboard (part 64 of 64)\n\nSquare 64 of the checkerboard is blue.",
    )
    // The embedding refusal pair is the request of the client to the non-ZDR
    // model, with no dimension and no quantizations. Only `zdr` differs.
    const [, , embeddingControl, embeddingRefused] = bodies.embeddings
    expect(embeddingControl).toEqual({
      model: "openai/text-embedding-ada-002",
      encoding_format: "float",
      input: [expect.stringMatching(/\nQuery:Is the sky blue\?$/)],
      provider: { data_collection: "deny", zdr: false },
    })
    expect(embeddingRefused).toEqual({
      ...embeddingControl,
      provider: { data_collection: "deny", zdr: true },
    })
  })

  it("fails the batch check on a gateway that takes one input per request", async () => {
    gateway({ enforcesZdr: true, maxInputs: 1 })

    expect(await run(0.05)).toBe(4)

    expect(await passes()).toMatchObject({
      "embedding-query": true,
      "embedding-text-batch": false,
    })
    expect(
      (await readResult()).checks.find(
        (check) => check.name === "embedding-text-batch",
      ),
    ).toMatchObject({
      status: 404,
      error: expect.stringContaining(
        "No endpoints found matching your data policy (Zero data retention).",
      ),
    })
  })

  it("fails each check that the answers do not prove", async () => {
    gateway({
      enforcesZdr: false,
      jevName: "Other Host",
      // A ZDR endpoint of the model, but at a low precision (fp8).
      embeddingName: "SiliconFlow",
      dimensions: 768,
    })

    expect(await run(0.05)).toBe(4)

    expect(await passes()).toEqual({
      "decisions-zdr-provider": false,
      "decisions-control-without-zdr": true,
      "decisions-refused-without-zdr-endpoint": false,
      "embedding-query": false,
      "embedding-text-batch": false,
      "embedding-control-without-zdr": true,
      "embedding-refused-without-zdr-endpoint": false,
    })
    const result = await readResult()
    expect(result.checks[0]?.provider).toBe("Other Host")
    expect(result.checks[2]?.status).toBe(200)
    expect(result.checks[3]).toMatchObject({
      provider: "SiliconFlow",
      error: "Expected 1024 dimensions at index 0, got 768",
    })
  })

  it.each([
    { status: 400, message: "Unknown field: zdr" },
    { status: 403, message: "The request was flagged by moderation." },
    { status: 404, message: "Not found." },
  ])("does not take an unrelated $status refusal as proof", async (refusal) => {
    gateway({ enforcesZdr: true, refusal })

    expect(await run(0.05)).toBe(4)

    expect(await passes()).toMatchObject({
      "decisions-control-without-zdr": true,
      "decisions-refused-without-zdr-endpoint": false,
    })
  })

  it("does not take a refusal as proof when the control is refused too", async () => {
    gateway({ enforcesZdr: true })
    server.use(
      http.post(DECISIONS, async ({ request }) => {
        const body = decisionSchema.parse(await request.clone().json())
        // The Jev model falls through to the gateway.
        if (body.model === "typesafe/jev-1.14") return
        return HttpResponse.json(
          { error: { message: "No endpoints found for this model." } },
          { status: 404 },
        )
      }),
    )

    expect(await run(0.05)).toBe(4)

    expect(await passes()).toMatchObject({
      "decisions-zdr-provider": true,
      "decisions-control-without-zdr": false,
      "decisions-refused-without-zdr-endpoint": false,
    })
  })

  it.each([
    ["an error status", () => new HttpResponse("down", { status: 502 })],
    ["the wrong shape", () => HttpResponse.json({ endpoints: [] })],
  ])(
    "fails with a zdr-list check when the ZDR list gives %s",
    async (_, answer) => {
      gateway({ enforcesZdr: true })
      server.use(http.get(`${BASE}/endpoints/zdr`, answer))

      expect(await run(0.05)).toBe(4)

      const result = await readResult()
      expect(result.checks[0]).toMatchObject({ name: "zdr-list", pass: false })
      expect(result.checks[0]?.error).toBeTruthy()
      // With no ZDR provider, no provider check passes.
      expect(await passes()).toMatchObject({
        "decisions-zdr-provider": false,
        "embedding-query": false,
      })
    },
  )

  it("stops at the spend cap", async () => {
    gateway({ enforcesZdr: true })

    // Each Jev call reserves $0.002: the first one fits, the second not.
    expect(await run(0.002)).toBe(3)

    const result = await readResult()
    expect(result.stopped).toBe(true)
    expect(result.spentUsd).toBeCloseTo(0.0001)
    expect(result.checks.map((check) => [check.pass, check.status])).toEqual([
      [true, 200],
      [false, null],
      [false, null],
      [false, null],
      [false, null],
      [false, null],
      [false, null],
    ])
    expect(result.checks[2]?.error).toBe(
      "The spend cap stopped the probe before this check.",
    )
  })
})

describe("the provider probe controls", () => {
  const controlSchema = z.object({
    model: z.string(),
    input: z.array(z.unknown()),
    provider: z
      .object({
        zdr: z.boolean(),
        order: z.array(z.string()).optional(),
      })
      .passthrough(),
  })

  it("sends each control once and records its status, provider, error, vector count and latency", async () => {
    const bodies: z.infer<typeof controlSchema>[] = []
    // A gateway that refuses each request pinned to `siliconflow/fp8`.
    server.use(
      http.post(EMBEDDINGS, async ({ request }) => {
        const body = controlSchema.parse(await request.json())
        bodies.push(body)
        if (body.provider.order?.[0] === "siliconflow/fp8")
          return HttpResponse.json(
            {
              error: {
                message:
                  "No endpoints found matching your data policy (Zero data retention).",
              },
            },
            { status: 404 },
          )
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ embedding: [0.1], index })),
          provider: "Other",
          usage: { cost: 0.00001 },
        })
      }),
    )

    const capUsd = 0.05
    expect(
      await probeControls({
        out,
        calls: new ModelCalls(BASE, capUsd),
        capUsd,
        base: BASE,
      }),
    ).toBe(0)

    const result = z
      .object({
        controls: z.array(
          z.object({
            name: z.string(),
            status: z.number().nullable(),
            provider: z.string().nullable(),
            error: z.string().nullable(),
            vectors: z.number().nullable(),
            latencyMs: z.number().nullable(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(join(out, "controls.json"), "utf8")))
    const refused =
      "No endpoints found matching your data policy (Zero data retention)."
    expect(
      result.controls.map(({ name, status, error, vectors }) => [
        name,
        status,
        error,
        vectors,
      ]),
    ).toEqual([
      ["qwen3-embedding-8b-16-strings-zdr-deepinfra-us", 200, null, 16],
      ["qwen3-embedding-8b-64-strings-zdr-deepinfra-us", 200, null, 64],
      ["qwen3-embedding-8b-16-strings-zdr-nebius-bf16", 200, null, 16],
      ["qwen3-embedding-8b-64-strings-zdr-nebius-bf16", 200, null, 64],
      ["qwen3-embedding-8b-16-strings-zdr-siliconflow-fp8", 404, refused, null],
      ["qwen3-embedding-8b-64-strings-zdr-siliconflow-fp8", 404, refused, null],
      ["pplx-embed-v1-4b-16-strings-zdr-perplexity-int8", 200, null, 16],
      ["pplx-embed-v1-4b-64-strings-zdr-perplexity-int8", 200, null, 64],
      ["text-embedding-3-small-16-strings-zdr-azure", 200, null, 16],
      ["text-embedding-3-small-64-strings-zdr-azure", 200, null, 64],
    ])
    expect(bodies).toHaveLength(10)
    // Each answered control records the time of its call.
    expect(
      result.controls.every(
        (control) => control.latencyMs !== null && control.latencyMs >= 0,
      ),
    ).toBe(true)
    // A control pins one ZDR endpoint with no fallback.
    expect(bodies[1]).toMatchObject({
      model: "qwen/qwen3-embedding-8b",
      provider: {
        data_collection: "deny",
        order: ["deepinfra/us"],
        allow_fallbacks: false,
        zdr: true,
      },
    })
    expect(bodies[1]?.input).toHaveLength(64)
    expect(bodies[1]?.input.at(-1)).toBe(
      "Square 64 of the checkerboard is blue.",
    )
    // Only the fixed texts go out.
    expect(
      bodies
        .flatMap((body) => body.input)
        .every((text) =>
          /^Square \d+ of the checkerboard is (red|blue)\.$/.test(String(text)),
        ),
    ).toBe(true)
    expect(await readFile(join(out, "controls.md"), "utf8")).toContain(
      "| qwen3-embedding-8b-64-strings-zdr-nebius-bf16 | Does qwen/qwen3-embedding-8b on nebius/bf16 take a batch?",
    )
  })
})
