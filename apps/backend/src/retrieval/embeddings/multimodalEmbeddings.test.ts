import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import {
  embedMultimodal,
  type EmbeddingInput,
  multimodalEmbeddingConfig,
} from "./multimodalEmbeddings.js"

const EMBEDDINGS_URL = "https://gateway.test/api/v1/embeddings"
const server = useMswServer()
const spans = recordSpans()

const config = {
  ...multimodalEmbeddingConfig,
  model: "vendor/multimodal-embed",
  upstreamProvider: "vendor-cloud",
  dimensions: 16,
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
    kind: "text",
    text: `chunk ${n}`,
    documentTitle: "Design\n  notes",
    chunkIndex: n,
    chunkCount: 5,
  }
}

type Body = {
  model: string
  input: { content: Record<string, unknown>[] }[]
  dimensions: number
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

describe("embedMultimodal", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://gateway.test/api/v1/")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("sends one no-retention, pinned-provider request for each input, at most `concurrency` at a time, and keeps the input order", async () => {
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
        const n = Number(/chunk (\d)/.exec(JSON.stringify(body.input))?.[1])
        return HttpResponse.json({
          data: [{ index: 0, embedding: vector(n) }],
        })
      }),
    )

    const result = embedMultimodal([0, 1, 2, 3, 4].map(text), config)

    // Two requests are in flight; a new one starts only when the test
    // releases an answer. The newest answer goes first, so the answers come
    // back in another order than the requests.
    for (const inFlight of [2, 2, 2, 2, 1]) {
      await vi.waitFor(() => expect(held).toHaveLength(inFlight))
      held.pop()?.()
    }
    expect((await result).map((e) => e[0])).toEqual([0, 1, 2, 3, 4])
    expect(bodies).toHaveLength(5)
    for (const body of bodies) {
      expect(body.input).toHaveLength(1)
      expect(body.model).toBe("vendor/multimodal-embed")
      expect(body.dimensions).toBe(16)
      expect(body.provider).toEqual({
        data_collection: "deny",
        order: ["vendor-cloud"],
        allow_fallbacks: false,
        zdr: true,
      })
    }
    expect(auth).toEqual(Array.from({ length: 5 }, () => "Bearer test-key"))
    expect(bodies.map((body) => body.input[0])).toContainEqual({
      content: [
        { type: "text", text: "Design notes (part 2 of 5)\n\nchunk 1" },
      ],
    })
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
      embedMultimodal([0, 1, 2, 3, 4].map(text), config),
    ).rejects.toThrow("400")
    // The two first requests were in flight together; no third one started.
    expect(calls).toBe(2)
  })

  it("sends a search query as its text only, with no context line", async () => {
    const bodies: Body[] = []
    server.use(echoHandler(bodies))

    await embedMultimodal([{ kind: "query", text: "why did it fail" }], config)

    expect(bodies[0]?.input).toEqual([
      { content: [{ type: "text", text: "why did it fail" }] },
    ])
  })

  it("sends an image as a data URI part and no text part", async () => {
    const bodies: Body[] = []
    server.use(echoHandler(bodies))

    await embedMultimodal(
      [
        {
          kind: "image",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
        },
      ],
      config,
    )

    expect(bodies[0]?.input).toEqual([
      {
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw==" },
          },
        ],
      },
    ])
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

    expect(await embedMultimodal([text(0)], config)).toEqual([values])
  })

  it("rejects a vector with the wrong dimension", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      ),
    )

    await expect(embedMultimodal([text(0)], config)).rejects.toThrow(
      "Expected 16 dimensions at index 0, got 3",
    )
  })

  it("retries 429 and 5xx, with one span for each request and the usage on the answered one", async () => {
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

    const result = await embedMultimodal([text(0)], config)

    expect(result).toHaveLength(1)
    const requests = spans
      .finishedSpans()
      .filter((s) => s.name === "embeddings.embedMultimodal")
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

    const error = await embedMultimodal([text(0)], config).catch(
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

    const error = await embedMultimodal([text(0)], config).catch(
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

    const result = await embedMultimodal([text(0)], config)

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

    const error = await embedMultimodal([text(0)], config).catch(
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

    await expect(embedMultimodal([text(0)], config)).rejects.toThrow("400")
    expect(calls).toBe(1)
  })

  it("keeps the no-endpoint message for the model of the request", async () => {
    server.use(
      http.post(EMBEDDINGS_URL, () =>
        HttpResponse.json(
          {
            error: {
              message: "No endpoints found for vendor/multimodal-embed.",
            },
          },
          { status: 404 },
        ),
      ),
    )

    await expect(embedMultimodal([text(0)], config)).rejects.toThrow(
      "Embedding request failed: HTTP 404: No endpoints found for vendor/multimodal-embed.",
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

    await expect(embedMultimodal([text(0)], config)).rejects.toThrow(
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

      const error = await embedMultimodal([text(0)], config).catch(
        (err: unknown) => err,
      )

      expect(String(error)).toBe("Error: Embedding request failed: HTTP 400")
    },
  )
})
