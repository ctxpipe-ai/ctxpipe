import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import {
  type EmbeddingInput,
  embeddingKey,
  embedQuery,
  embedTexts,
  textEmbeddingConfig,
} from "./textEmbeddings.js"

const EMBEDDINGS_URL = "https://gateway.test/api/v1/embeddings"
const server = useMswServer()
const spans = recordSpans()

const config = {
  ...textEmbeddingConfig,
  model: "vendor/text-embed",
  dimensions: 16,
  maxBatchInputs: 2,
  concurrency: 2,
  maxAttempts: 3,
  backoffMs: 1,
  maxBackoffMs: 2,
}

function vector(seed: number): number[] {
  return Array.from({ length: 16 }, (_, i) => (i === 0 ? seed : -1))
}

function text(n: number): EmbeddingInput {
  return {
    text: `chunk ${n}`,
    documentTitle: "Design\n  notes",
    chunkIndex: n,
    chunkCount: 5,
  }
}

type Body = {
  model: string
  input: string[]
  dimensions: number
  encoding_format: string
  provider: unknown
}

/** Answers each request with one vector for each input, `index` reversed. */
function echoHandler(bodies: Body[]) {
  return http.post(EMBEDDINGS_URL, async ({ request }) => {
    const body = (await request.json()) as Body
    bodies.push(body)
    const data = body.input
      .map((_, index) => ({
        object: "embedding",
        index,
        embedding: vector(bodies.length * 10 + index),
      }))
      .reverse()
    return HttpResponse.json({
      object: "list",
      data,
      usage: { prompt_tokens: 7, total_tokens: 7, cost: 0.002 },
    })
  })
}

describe("embedTexts", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://gateway.test/api/v1/")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("sends the inputs in no-retention batches of `maxBatchInputs`, at most `concurrency` at a time, and keeps the input order", async () => {
    const bodies: Body[] = []
    const auth: (string | null)[] = []
    // Each answer waits until the test releases it.
    const held: (() => void)[] = []
    server.use(
      http.post(EMBEDDINGS_URL, async ({ request }) => {
        auth.push(request.headers.get("authorization"))
        const body = (await request.json()) as Body
        bodies.push(body)
        await new Promise<void>((resolve) => held.push(resolve))
        // The vectors come back in reverse order; `index` names the input.
        return HttpResponse.json({
          data: body.input
            .map((input, index) => ({
              index,
              embedding: vector(Number(/chunk (\d)/.exec(input)?.[1])),
            }))
            .reverse(),
        })
      }),
    )

    const result = embedTexts([0, 1, 2, 3, 4].map(text), config)

    // Two requests are in flight; a new one starts only when the test
    // releases an answer. The newest answer goes first, so the answers come
    // back in another order than the requests.
    for (const inFlight of [2, 2, 1]) {
      await vi.waitFor(() => expect(held).toHaveLength(inFlight))
      held.pop()?.()
    }
    expect((await result).map((e) => e[0])).toEqual([0, 1, 2, 3, 4])
    expect(bodies.map((body) => body.input.length)).toEqual([2, 2, 1])
    for (const body of bodies) {
      expect(body.model).toBe("vendor/text-embed")
      expect(body.dimensions).toBe(16)
      expect(body.encoding_format).toBe("float")
      expect(body.provider).toEqual({ data_collection: "deny", zdr: true })
    }
    expect(auth).toEqual(Array.from({ length: 3 }, () => "Bearer test-key"))
    // Each chunk is a plain string with the context line of its document.
    expect(bodies.flatMap((body) => body.input)).toContain(
      "Design notes (part 2 of 5)\n\nchunk 1",
    )
  })

  it("closes a batch before an input that puts its UTF-8 bytes over `maxBatchBytes`", async () => {
    const bodies: Body[] = []
    server.use(echoHandler(bodies))
    // "Design notes (part N of 5)\n\n" is 28 bytes. Each "é" is 2 bytes.
    const chunk = (n: number, accents: number): EmbeddingInput => ({
      ...text(n),
      text: "é".repeat(accents),
    })
    const limits = { ...config, maxBatchInputs: 10, maxBatchBytes: 100 }

    const result = await embedTexts(
      [chunk(0, 11), chunk(1, 25), chunk(2, 25), chunk(3, 40), chunk(4, 1)],
      limits,
    )

    // 50 + 78 > 100; 78 alone; 78 + 108 > 100; 108 alone (over the limit,
    // so the provider decides); 108 + 30 > 100.
    expect(bodies.map((body) => body.input.length)).toEqual([1, 1, 1, 1, 1])
    expect(result).toHaveLength(5)

    bodies.length = 0
    await embedTexts(
      [0, 1, 2].map((n) => chunk(n, 7)),
      limits,
    )
    // 3 × 42 bytes: two fit in 100, the third does not.
    expect(bodies.map((body) => body.input.length)).toEqual([2, 1])
  })

  it("cuts an input over `maxInputBytes` at a code point, and the key holds the cut text", async () => {
    const bodies: Body[] = []
    server.use(echoHandler(bodies))
    const limits = { ...config, maxInputBytes: 33 }
    // The context line and the blank line are 28 bytes. 2 + 2 bytes of "é"
    // fit; the third "é" would end at byte 34, so the cut drops it.
    const long = { ...text(0), text: "éééé" }
    const exact = { ...text(0), text: "éé" }

    await embedTexts([long], limits)

    expect(bodies[0]?.input).toEqual(["Design notes (part 1 of 5)\n\néé"])
    expect(embeddingKey(long, limits)).toBe(embeddingKey(exact, limits))
    expect(embeddingKey(long, limits)).not.toBe(embeddingKey(long, config))

    await embedQuery("ü".repeat(20), limits)
    expect(bodies[1]?.input).toEqual(["ü".repeat(16)])
  })

  it("sends nothing when the model settings do not point at OpenRouter", async () => {
    vi.stubEnv("MODEL_PROVIDER", "bedrock")
    const bodies: Body[] = []
    server.use(echoHandler(bodies))

    await expect(embedTexts([text(0)], config)).rejects.toThrow(
      /MODEL_PROVIDER openrouter or openai-like/,
    )
    expect(bodies).toEqual([])
  })

  it("rejects an answer with fewer vectors than inputs", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json({ data: [{ index: 0, embedding: vector(0) }] }),
      ),
    )

    await expect(embedTexts([text(0), text(1)], config)).rejects.toThrow(
      "Expected 2 embeddings, got 1",
    )
  })

  it("rejects an answer that gives one index twice", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json({
          data: [
            { index: 1, embedding: vector(0) },
            { index: 1, embedding: vector(1) },
          ],
        }),
      ),
    )

    await expect(embedTexts([text(0), text(1)], config)).rejects.toThrow(
      "Unexpected embedding index 1",
    )
  })

  it("starts no new request after a failure", async () => {
    let calls = 0
    server.use(
      http.post(EMBEDDINGS_URL, () => {
        calls += 1
        return new HttpResponse("bad model", { status: 400 })
      }),
    )

    await expect(
      embedTexts([0, 1, 2, 3, 4, 5].map(text), config),
    ).rejects.toThrow("400")
    // The two first batches were in flight together; no third one started.
    expect(calls).toBe(2)
  })

  it("rejects after the requests in flight end, also their retries", async () => {
    const sent: string[] = []
    server.use(
      http.post(EMBEDDINGS_URL, async ({ request }) => {
        const body = (await request.json()) as Body
        // The first chunk of the batch names the batch.
        const batch = /chunk (\d)/.exec(body.input[0] ?? "")?.[1] ?? "?"
        sent.push(batch)
        if (batch === "0") return new HttpResponse("bad model", { status: 400 })
        // The first answer to batch 2 comes after the 400, and is a 429.
        if (sent.filter((item) => item === "2").length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return new HttpResponse("busy", { status: 429 })
        }
        return HttpResponse.json({
          data: body.input.map((_, index) => ({ index, embedding: vector(1) })),
        })
      }),
    )
    let requests = 0
    await expect(
      embedTexts([0, 1, 2, 3, 4, 5].map(text), config, () => requests++),
    ).rejects.toThrow("400")
    // The retry of batch 2 went out before the rejection, and batch 4 never.
    expect(sent.sort()).toEqual(["0", "2", "2"])
    expect(requests).toBe(3)
  })

  it("returns the full vector of each input as numbers", async () => {
    const values = [
      1, -2, 0.1, 0, 3.5, -0.25, 1e-3, -1e-3, 0, 0, -5, 0, 0, 0, 0, 2,
    ]
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json({ data: [{ index: 0, embedding: values }] }),
      ),
    )

    expect(await embedTexts([text(0)], config)).toEqual([values])
  })

  it("rejects a vector with the wrong dimension", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      ),
    )

    await expect(embedTexts([text(0)], config)).rejects.toThrow(
      "Expected 16 dimensions at index 0, got 3",
    )
  })

  it("retries 429 and 5xx, with one span and one `onRequest` call for each request, and the usage on the answered one", async () => {
    const statuses = [429, 503]
    const bodies: Body[] = []
    const echo = echoHandler(bodies)
    server.use(
      http.post(EMBEDDINGS_URL, () => {
        const status = statuses.shift()
        return status ? new HttpResponse("busy", { status }) : undefined
      }),
      echo,
    )

    let sent = 0
    const result = await embedTexts([text(0)], config, () => sent++)

    expect(result).toHaveLength(1)
    expect(sent).toBe(3)
    const requests = spans
      .finishedSpans()
      .filter((s) => s.name === "embeddings.embedTexts")
    expect(requests.map((s) => s.status.message)).toEqual([
      "Embedding request failed: HTTP 429",
      "Embedding request failed: HTTP 503",
      undefined,
    ])
    const attrs = requests[2]?.attributes ?? {}
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(7)
    expect(attrs["gen_ai.usage.cost"]).toBe(0.002)
    expect(JSON.stringify(attrs)).not.toContain("chunk 0")
    expect(JSON.stringify(attrs)).not.toContain("Design notes")
  })

  it("fails after the attempt cap, and keeps an echoed input out of the error and the spans", async () => {
    let calls = 0
    server.use(
      http.post(EMBEDDINGS_URL, async ({ request }) => {
        calls += 1
        return new HttpResponse(`upstream error for: ${await request.text()}`, {
          status: 502,
        })
      }),
    )

    const error = await embedTexts([text(0)], config).catch(
      (err: unknown) => err,
    )

    expect(calls).toBe(3)
    expect((error as Error).message).toBe("Embedding request failed: HTTP 502")
    const telemetry = JSON.stringify(
      spans
        .finishedSpans()
        .map((s) => ({ status: s.status, attributes: s.attributes })),
    )
    expect(telemetry).toContain("HTTP 502")
    expect(telemetry).not.toContain("chunk 0")
  })

  it("keeps an echoed input in a malformed answer out of the error and the spans", async () => {
    server.use(
      http.post(
        EMBEDDINGS_URL,
        async ({ request }) =>
          new HttpResponse(`{not json ${await request.text()}`, {
            status: 200,
          }),
      ),
    )

    const error = await embedTexts([text(0)], config).catch(
      (err: unknown) => err,
    )

    expect(String(error)).not.toContain("chunk 0")
    const telemetry = JSON.stringify(
      spans
        .finishedSpans()
        .map((s) => ({ status: s.status, attributes: s.attributes })),
    )
    expect(telemetry).toContain("not valid JSON")
    expect(telemetry).not.toContain("chunk 0")
  })

  it("retries a network error like a 5xx", async () => {
    let failures = 1
    const bodies: Body[] = []
    const echo = echoHandler(bodies)
    server.use(
      http.post(EMBEDDINGS_URL, () => {
        if (failures-- > 0) return HttpResponse.error()
        return undefined
      }),
      echo,
    )

    const result = await embedTexts([text(0)], config)

    expect(result).toHaveLength(1)
    expect(bodies).toHaveLength(1)
  })

  it("stops network error retries at the attempt cap", async () => {
    let calls = 0
    server.use(
      http.post(EMBEDDINGS_URL, () => {
        calls += 1
        return HttpResponse.error()
      }),
    )

    const error = await embedTexts([text(0)], config).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(TypeError)
    expect(String(error)).not.toContain("chunk 0")
    expect(calls).toBe(3)
  })

  it("does not retry a 4xx other than 429", async () => {
    let calls = 0
    server.use(
      http.post(EMBEDDINGS_URL, () => {
        calls += 1
        return new HttpResponse("bad model", { status: 400 })
      }),
    )

    await expect(embedTexts([text(0)], config)).rejects.toThrow("400")
    expect(calls).toBe(1)
  })

  it("keeps the no-endpoint message for the model of the request", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json(
          {
            error: {
              message: "No endpoints found for vendor/text-embed.",
            },
          },
          { status: 404 },
        ),
      ),
    )

    await expect(embedTexts([text(0)], config)).rejects.toThrow(
      "Embedding request failed: HTTP 404: No endpoints found for vendor/text-embed.",
    )
  })

  it("keeps a fixed routing message of the gateway in a 4xx error and its span", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json(
          {
            error: {
              code: 404,
              message:
                "No endpoints found that can handle the requested parameters.",
            },
          },
          { status: 404 },
        ),
      ),
    )

    await expect(embedTexts([text(0)], config)).rejects.toThrow(
      "Embedding request failed: HTTP 404: No endpoints found that can handle the requested parameters.",
    )
    expect(
      JSON.stringify(spans.finishedSpans().map((s) => s.status)),
    ).toContain("No endpoints found that can handle the requested parameters.")
  })

  it.each([
    (input: string) => `Invalid input: ${input}`,
    (input: string) => `No endpoints found for input: ${input}`,
    (input: string) =>
      `No endpoints found that can handle the requested parameters. ${input}`,
    (input: string) => `No allowed providers are available for ${input}.`,
    // A model-shaped id other than the model of the request.
    () => "No endpoints found for private-org/private-repository.",
  ])(
    "keeps another 4xx message out of the error, because it can echo the input (%#)",
    async (echo) => {
      server.use(
        http.post(EMBEDDINGS_URL, async ({ request }) =>
          HttpResponse.json(
            { error: { message: echo(await request.text()) } },
            { status: 400 },
          ),
        ),
      )

      const error = await embedTexts([text(0)], config).catch(
        (err: unknown) => err,
      )

      expect(String(error)).toBe(
        "EmbeddingError: Embedding request failed: HTTP 400",
      )
      expect(error).toMatchObject({ status: 400 })
    },
  )
})

describe("embedQuery", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://gateway.test/api/v1/")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("sends a search question as it is, with no context line, and the ZDR provider block sorted by latency", async () => {
    const bodies: Body[] = []
    server.use(echoHandler(bodies))

    expect(await embedQuery("why did it fail", config)).toEqual(vector(10))

    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.input).toEqual(["why did it fail"])
    // No pin, no order and no `allow_fallbacks: false`: OpenRouter falls
    // back among the ZDR endpoints in the order of their latency.
    expect(bodies[0]?.provider).toEqual({
      data_collection: "deny",
      zdr: true,
      sort: "latency",
    })
  })

  it.each([
    ["a 429", () => new HttpResponse("busy", { status: 429 })],
    ["a 503", () => new HttpResponse("busy", { status: 503 })],
    ["a network error", () => HttpResponse.error()],
  ])(
    "does not retry a search question after %s, so it makes no backoff wait",
    async (_, failure) => {
      let calls = 0
      server.use(
        http.post(EMBEDDINGS_URL, () => {
          calls += 1
          return failure()
        }),
      )
      // A backoff of one minute: a wait would time out the test.
      const slow = { ...config, backoffMs: 60_000, maxBackoffMs: 60_000 }

      await expect(embedQuery("why did it fail", slow)).rejects.toThrow()

      expect(calls).toBe(1)
    },
  )
})
