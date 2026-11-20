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
  vi.stubEnv("MODEL_PROVIDER_URL", BASE)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  out = await mkdtemp(join(tmpdir(), "knowledge-probe-"))
})
afterEach(async () => {
  await rm(out, { recursive: true, force: true })
})

const providerSchema = z.object({
  data_collection: z.string(),
  order: z.array(z.string()),
  allow_fallbacks: z.boolean(),
  zdr: z.boolean(),
})
const decisionSchema = z.object({
  model: z.string(),
  state: z.array(z.unknown()),
  questions: z.record(z.string(), z.unknown()),
  provider: providerSchema,
})
const embeddingSchema = z.object({
  model: z.string(),
  dimensions: z.number(),
  input: z.array(z.object({ content: z.array(z.unknown()) })),
  encoding_format: z.string(),
  provider: providerSchema,
})

/** The Decisions endpoints of the fake catalog, as on OpenRouter. */
const ENDPOINTS: Record<string, { slug: string; name: string; zdr: boolean }> =
  {
    "typesafe/jev-1.14": { slug: "typesafe", name: "TypeSafe", zdr: true },
    "openai/gpt-6-luna-decisions": {
      slug: "openai",
      name: "OpenAI",
      zdr: false,
    },
  }

/**
 * A gateway that routes Decisions requests like OpenRouter: by the pinned
 * provider, and with `zdr: true` only to a ZDR endpoint. With
 * `enforcesZdr: false`, it ignores `zdr`. `refusal` replaces the answer to a
 * request with `zdr: true` to the non-ZDR model. A request with more than
 * `maxInputs` embedding inputs finds no endpoint.
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
        !body.provider.order.includes(endpoint.slug) ||
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
      if (body.input.length > (options.maxInputs ?? Infinity))
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
        provider: options.embeddingName ?? "Google",
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
  probe({ out, calls: new ModelCalls(BASE, capUsd), capUsd })
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
        name: "decisions-pinned",
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
        name: "embedding-image",
        pass: true,
        status: 200,
        provider: "Google",
      }),
      expect.objectContaining({ name: "embedding-text", pass: true }),
      expect.objectContaining({ name: "embedding-text-batch", pass: true }),
    ])
    expect(result.stopped).toBe(false)
    expect(await readFile(join(out, "probe.md"), "utf8")).toContain(
      "| decisions-pinned | pass | 200 | TypeSafe |",
    )

    // The control and the refused request are the request of the real
    // client: only the model, the pinned provider and `zdr` change.
    const [pinned, control, refused] = bodies.decisions
    expect(pinned?.provider).toEqual({
      data_collection: "deny",
      order: ["typesafe"],
      allow_fallbacks: false,
      zdr: true,
    })
    const nonZdr = {
      ...pinned,
      model: "openai/gpt-6-luna-decisions",
      state: ["The sky is green."],
    }
    expect(control).toEqual({
      ...nonZdr,
      provider: { ...pinned?.provider, order: ["openai"], zdr: false },
    })
    expect(refused).toEqual({
      ...nonZdr,
      provider: { ...pinned?.provider, order: ["openai"] },
    })

    // The image goes as a PNG data URI of the checkerboard fixture, to the
    // pinned provider with ZDR.
    const image = await readFile(
      new URL(
        "../../evals/knowledge/fixtures/probe-checkerboard.png",
        import.meta.url,
      ),
    )
    expect(bodies.embeddings[0]).toEqual({
      model: "google/gemini-embedding-2",
      dimensions: 1024,
      encoding_format: "float",
      input: [
        {
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${image.toString("base64")}`,
              },
            },
          ],
        },
      ],
      provider: {
        data_collection: "deny",
        order: ["google-vertex"],
        allow_fallbacks: false,
        zdr: true,
      },
    })
    expect(bodies.embeddings[1]?.input).toEqual([
      { content: [{ type: "text", text: "A red and blue checkerboard." }] },
    ])
    // The batch is 16 requests, each with one document chunk and the
    // context line of the projection.
    expect(bodies.embeddings).toHaveLength(18)
    expect(bodies.embeddings.every((body) => body.input.length === 1)).toBe(
      true,
    )
    expect(bodies.embeddings.map((body) => body.input[0])).toContainEqual({
      content: [
        {
          type: "text",
          text: "Checkerboard (part 16 of 16)\n\nSquare 16 of the checkerboard is blue.",
        },
      ],
    })
  })

  it("passes the batch check on a gateway that takes one input per request, as the ZDR endpoints do", async () => {
    gateway({ enforcesZdr: true, maxInputs: 1 })

    expect(await run(0.05)).toBe(0)
  })

  it("fails each check that the answers do not prove", async () => {
    gateway({
      enforcesZdr: false,
      jevName: "Other Host",
      embeddingName: "Google AI Studio",
      dimensions: 768,
    })

    expect(await run(0.05)).toBe(4)

    expect(await passes()).toEqual({
      "decisions-pinned": false,
      "decisions-control-without-zdr": true,
      "decisions-refused-without-zdr-endpoint": false,
      "embedding-image": false,
      "embedding-text": false,
      "embedding-text-batch": false,
    })
    const result = await readResult()
    expect(result.checks[0]?.provider).toBe("Other Host")
    expect(result.checks[2]?.status).toBe(200)
    expect(result.checks[3]).toMatchObject({
      provider: "Google AI Studio",
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
      "decisions-pinned": true,
      "decisions-control-without-zdr": false,
      "decisions-refused-without-zdr-endpoint": false,
    })
  })

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

  it("sends each control once and records its status, provider, error and vector count", async () => {
    const bodies: z.infer<typeof controlSchema>[] = []
    // A gateway with the batch finding: with zdr true, Gemini has no
    // endpoint for more than one input.
    server.use(
      http.post(EMBEDDINGS, async ({ request }) => {
        const body = controlSchema.parse(await request.json())
        bodies.push(body)
        if (
          body.model === "google/gemini-embedding-2" &&
          body.provider.zdr &&
          body.input.length > 1
        )
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
          provider: body.model.startsWith("google/") ? "Google" : "Other",
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
      ["gemini-16-multimodal-zdr", 404, refused, null],
      ["gemini-1-multimodal-zdr", 200, null, 1],
      ["gemini-16-multimodal-no-zdr", 200, null, 16],
      ["gemini-16-multimodal-no-zdr-no-pin", 200, null, 16],
      ["gemini-16-strings-zdr", 404, refused, null],
      ["gemini-2-multimodal-zdr", 404, refused, null],
      ["gemini-4-multimodal-zdr", 404, refused, null],
      ["gemini-16-multimodal-zdr-no-pin", 404, refused, null],
      ["gemini-16-multimodal-zdr-google-vertex-us", 404, refused, null],
      ["gemini-16-multimodal-no-zdr-google-vertex-us", 200, null, 16],
      ["gemini-16-multimodal-zdr-google-vertex-global", 404, refused, null],
      ["gemini-16-multimodal-no-zdr-google-vertex-global", 200, null, 16],
      ["gemini-16-multimodal-no-zdr-google-ai-studio", 200, null, 16],
      ["gemini-batch-16-multimodal-zdr", 200, null, 16],
      ["gemini-batch-16-multimodal-no-zdr", 200, null, 16],
      ["titan-16-strings-zdr", 200, null, 16],
      ["openai-3-large-16-strings-zdr", 200, null, 16],
      ["qwen3-embedding-8b-16-strings-zdr-deepinfra-us", 200, null, 16],
      ["qwen3-embedding-8b-64-strings-zdr-deepinfra-us", 200, null, 64],
      ["qwen3-embedding-8b-16-strings-zdr-nebius-bf16", 200, null, 16],
      ["qwen3-embedding-8b-64-strings-zdr-nebius-bf16", 200, null, 64],
      ["text-embedding-3-small-16-strings-zdr-azure", 200, null, 16],
      ["text-embedding-3-small-64-strings-zdr-azure", 200, null, 64],
    ])
    expect(bodies).toHaveLength(23)
    expect(bodies[8]?.provider).toEqual({
      data_collection: "deny",
      order: ["google-vertex/us"],
      allow_fallbacks: false,
      zdr: true,
    })
    // A text-space control pins one ZDR endpoint with no fallback.
    expect(bodies[18]).toMatchObject({
      model: "qwen/qwen3-embedding-8b",
      provider: {
        data_collection: "deny",
        order: ["deepinfra/us"],
        allow_fallbacks: false,
        zdr: true,
      },
    })
    expect(bodies[18]?.input).toHaveLength(64)
    expect(bodies[18]?.input.at(-1)).toBe(
      "Square 64 of the checkerboard is blue.",
    )
    // Only the fixed texts go out.
    expect(JSON.stringify(bodies)).not.toMatch(
      /"text":"(?!Square \d+ of the checkerboard is (red|blue)\.)/,
    )
    expect(await readFile(join(out, "controls.md"), "utf8")).toContain(
      "| gemini-16-multimodal-no-zdr | Is ZDR the cause?",
    )
  })
})
