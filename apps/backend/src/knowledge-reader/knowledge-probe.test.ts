import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { ModelCalls } from "../../evals/knowledge/model-calls.js"
import { probe } from "../../evals/knowledge/probe.js"
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
const CHAT = `${BASE}/chat/completions`

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
})
const decisionSchema = z.object({
  model: z.string(),
  state: z.array(z.unknown()),
  questions: z.record(z.string(), z.unknown()),
  provider: providerSchema,
})
const visionSchema = z.object({
  model: z.string(),
  messages: z.array(z.unknown()),
  response_format: z.object({ type: z.literal("json_schema") }),
  provider: providerSchema.extend({ require_parameters: z.boolean() }),
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

/** The vision endpoints of the fake catalog. */
const VISION_ENDPOINTS: Record<string, { name: string; zdr: boolean }> = {
  "openai/gpt-6.1-terra": { name: "Azure", zdr: true },
  "google/gemini-2.5-flash-lite": { name: "Google AI Studio", zdr: false },
}
const reading = {
  description: "A state machine.",
  text: "Created",
  diagram: {
    kind: "graph",
    direction: "LR",
    groups: [],
    nodes: [{ id: "c", label: "Created", group: "" }],
    edges: [],
    participants: [],
    messages: [],
  },
}

/** The fake OpenRouter ZDR list (`GET /api/v1/endpoints/zdr`). */
const ZDR_LIST = [
  ["typesafe/jev-1.14", "TypeSafe"],
  ["openai/gpt-6.1-terra", "Azure"],
  ["openai/text-embedding-3-large", "Azure"],
].map(([model_id = "", provider_name = ""]) => ({
  model_id,
  provider_name,
  tag: provider_name.toLowerCase(),
}))

/**
 * A gateway that routes Decisions requests like OpenRouter: with `zdr: true`
 * only to a ZDR endpoint. With
 * `enforcesZdr: false`, it ignores `zdr`. `refusal` replaces the answer to a
 * request with `zdr: true` to the non-ZDR model. Embedding requests route
 * the same way: `openai/text-embedding-ada-002` has no ZDR endpoint. A
 * request with more than `maxInputs` embedding inputs finds no endpoint.
 * A vision request routes the same way: `google/gemini-2.5-flash-lite` has
 * no ZDR endpoint.
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
    vision: [] as z.infer<typeof visionSchema>[],
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
    http.post(CHAT, async ({ request }) => {
      const body = visionSchema.parse(await request.json())
      bodies.vision.push(body)
      const { model } = body
      const endpoint = VISION_ENDPOINTS[model]
      if (
        !endpoint ||
        (options.enforcesZdr && body.provider.zdr && !endpoint.zdr)
      )
        return HttpResponse.json(
          {
            error: { message: "No endpoints found matching your data policy." },
          },
          { status: 404 },
        )
      return HttpResponse.json({
        model,
        provider: endpoint.name,
        choices: [{ message: { content: JSON.stringify(reading) } }],
        usage: { cost: 0.004 },
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
        provider: options.embeddingName ?? "Azure",
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

    expect(await run(0.25)).toBe(0)

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
        provider: "Azure",
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
      expect.objectContaining({
        name: "vision-read",
        pass: true,
        status: 200,
        provider: "Azure",
      }),
      expect.objectContaining({
        name: "vision-control-without-zdr",
        pass: true,
        status: 200,
      }),
      expect.objectContaining({
        name: "vision-refused-without-zdr-endpoint",
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

    // The question goes as it is, only to a ZDR endpoint.
    expect(bodies.embeddings[0]).toEqual({
      model: "openai/text-embedding-3-large",
      dimensions: 1024,
      encoding_format: "float",
      input: ["Which squares of the checkerboard are red?"],
      provider: { data_collection: "deny", zdr: true },
    })
    // The batch is one request with 2048 document chunks (the input limit
    // of the API), each with the context line of the projection.
    expect(bodies.embeddings).toHaveLength(4)
    expect(bodies.embeddings[1]?.input).toHaveLength(2048)
    expect(bodies.embeddings[1]?.input.at(-1)).toBe(
      "Checkerboard (part 2048 of 2048)\n\nSquare 2048 of the checkerboard is blue.",
    )
    // The embedding refusal pair is the request of the client to the non-ZDR
    // model, with no dimension. Only `zdr` differs.
    const [, , embeddingControl, embeddingRefused] = bodies.embeddings
    expect(embeddingControl).toEqual({
      model: "openai/text-embedding-ada-002",
      encoding_format: "float",
      input: ["Is the sky blue?"],
      provider: { data_collection: "deny", zdr: false },
    })
    expect(embeddingRefused).toEqual({
      ...embeddingControl,
      provider: { data_collection: "deny", zdr: true },
    })

    // The vision requests are the request of the client for the default
    // model, with the ZDR block and no pin; the refusal pair changes only
    // the model and `zdr`.
    const [vision, visionControl, visionRefused] = bodies.vision
    expect(vision?.model).toBe("openai/gpt-6.1-terra")
    expect(vision?.provider).toEqual({
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    })
    expect(visionControl).toEqual({
      ...vision,
      model: "google/gemini-2.5-flash-lite",
      provider: { ...vision?.provider, zdr: false },
    })
    expect(visionRefused).toEqual({
      ...visionControl,
      provider: { ...visionControl?.provider, zdr: true },
    })
  })

  it("fails the batch check on a gateway that takes one input per request", async () => {
    gateway({ enforcesZdr: true, maxInputs: 1 })

    expect(await run(0.25)).toBe(4)

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
      // An endpoint of the model that is not on the ZDR list.
      embeddingName: "OpenAI",
      dimensions: 768,
    })

    expect(await run(0.25)).toBe(4)

    expect(await passes()).toEqual({
      "decisions-zdr-provider": false,
      "decisions-control-without-zdr": true,
      "decisions-refused-without-zdr-endpoint": false,
      "embedding-query": false,
      "embedding-text-batch": false,
      "embedding-control-without-zdr": true,
      "embedding-refused-without-zdr-endpoint": false,
      "vision-read": true,
      "vision-control-without-zdr": true,
      "vision-refused-without-zdr-endpoint": false,
    })
    const result = await readResult()
    expect(result.checks[0]?.provider).toBe("Other Host")
    expect(result.checks[2]?.status).toBe(200)
    expect(result.checks[3]).toMatchObject({
      provider: "OpenAI",
      error: "Expected 1024 dimensions at index 0, got 768",
    })
  })

  it.each([
    { status: 400, message: "Unknown field: zdr" },
    { status: 403, message: "The request was flagged by moderation." },
    { status: 404, message: "Not found." },
  ])("does not take an unrelated $status refusal as proof", async (refusal) => {
    gateway({ enforcesZdr: true, refusal })

    expect(await run(0.25)).toBe(4)

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

    expect(await run(0.25)).toBe(4)

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

      expect(await run(0.25)).toBe(4)

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
      [false, null],
      [false, null],
      [false, null],
    ])
    expect(result.checks[2]?.error).toBe(
      "The spend cap stopped the probe before this check.",
    )
  })
})
