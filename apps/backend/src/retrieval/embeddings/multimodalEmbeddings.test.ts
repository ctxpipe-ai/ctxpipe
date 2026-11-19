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
  batchSize: 2,
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

  it("sends no-retention, pinned-provider requests in batches and keeps the input order", async () => {
    const bodies: Body[] = []
    const auth: (string | null)[] = []
    server.use(
      http.post(EMBEDDINGS_URL, ({ request }) => {
        auth.push(request.headers.get("authorization"))
      }),
      echoHandler(bodies),
    )

    const result = await embedMultimodal([0, 1, 2, 3, 4].map(text), config)

    expect(bodies.map((b) => b.input.length)).toEqual([2, 2, 1])
    for (const body of bodies) {
      expect(body.model).toBe("vendor/multimodal-embed")
      expect(body.dimensions).toBe(16)
      expect(body.provider).toEqual({
        data_collection: "deny",
        order: ["vendor-cloud"],
        allow_fallbacks: false,
      })
    }
    expect(auth).toEqual([
      "Bearer test-key",
      "Bearer test-key",
      "Bearer test-key",
    ])
    expect(bodies[0]?.input[1]).toEqual({
      content: [
        { type: "text", text: "Design notes (part 2 of 5)\n\nchunk 1" },
      ],
    })
    // The handler returns the rows in reverse order; `index` restores it.
    expect(result.map((e) => e[0])).toEqual([10, 11, 20, 21, 30])
  })

  it("sends an image as a data URI part with its alt text", async () => {
    const bodies: Body[] = []
    server.use(echoHandler(bodies))

    await embedMultimodal(
      [
        {
          kind: "image",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
          altText: "Deploy pipeline diagram",
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
          { type: "text", text: "Deploy pipeline diagram" },
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
    expect(String(error)).toBe("Error: Embedding request failed: HTTP 502")
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
})
