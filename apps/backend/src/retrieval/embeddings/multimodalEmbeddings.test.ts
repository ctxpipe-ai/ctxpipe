import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import {
  embedMultimodal,
  type EmbeddingInput,
  multimodalEmbeddingConfig,
} from "./multimodalEmbeddings.js"

const URL = "https://gateway.test/api/v1/embeddings"
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

/** Known values and their BFloat16 bit patterns (round to nearest even). */
const KNOWN = [1, -2, 0.1, 0, 3.5, -0.25, 1e-3, -1e-3]
const KNOWN_BF16 = [
  0x3f80, 0xc000, 0x3dcd, 0x0000, 0x4060, 0xbe80, 0x3a83, 0xba83,
]

function vector(seed: number): number[] {
  return Array.from({ length: 16 }, (_, i) => (i === 0 ? seed : -1))
}

function text(n: number): EmbeddingInput {
  return {
    kind: "text",
    text: `chunk ${n}`,
    documentTitle: "Design notes",
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
  return http.post(URL, async ({ request }) => {
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

function firstValue(bf16: Uint16Array): number {
  return new Float32Array(
    new Uint32Array([(bf16[0] as number) << 16]).buffer,
  )[0] as number
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
      http.post(URL, ({ request }) => {
        auth.push(request.headers.get("authorization"))
      }),
      echoHandler(bodies),
    )

    const result = await embedMultimodal([0, 1, 2, 3, 4].map(text), { config })

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
    expect(result.map((e) => firstValue(e.bfloat16))).toEqual([
      10, 11, 20, 21, 30,
    ])
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
      { config },
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

  it("returns the BFloat16 bit patterns and the packed sign bits of known values", async () => {
    const values = [...KNOWN, 0, 0, -5, 0, 0, 0, 0, 2]
    server.use(
      http.post(URL, () =>
        HttpResponse.json({ data: [{ index: 0, embedding: values }] }),
      ),
    )

    const [embedding] = await embedMultimodal([text(0)], { config })

    expect(Array.from(embedding?.bfloat16 ?? []).slice(0, 8)).toEqual(
      KNOWN_BF16,
    )
    // Positive at dimensions 0, 2, 4, 6 and 15; zero is not positive.
    expect(Array.from(embedding?.binary ?? [])).toEqual([
      0b10101010, 0b00000001,
    ])
  })

  it("retries 429 and 5xx, then records one span with tokens and cost and no content", async () => {
    const statuses = [429, 503]
    const bodies: Body[] = []
    const echo = echoHandler(bodies)
    server.use(
      http.post(URL, () => {
        const status = statuses.shift()
        return status ? new HttpResponse("busy", { status }) : undefined
      }),
      echo,
    )

    const result = await embedMultimodal([text(0)], { config })

    expect(result).toHaveLength(1)
    const generations = spans
      .finishedSpans()
      .filter((s) => s.name === "embeddings.embedMultimodal")
    expect(generations).toHaveLength(1)
    const attrs = generations[0]?.attributes ?? {}
    expect(attrs["ctxpipe.embeddings.attempts"]).toBe(3)
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(7)
    expect(attrs["gen_ai.usage.cost"]).toBe(0.002)
    expect(JSON.stringify(attrs)).not.toContain("chunk 0")
    expect(JSON.stringify(attrs)).not.toContain("Design notes")
  })

  it("fails after the attempt cap", async () => {
    let calls = 0
    server.use(
      http.post(URL, () => {
        calls += 1
        return new HttpResponse("down", { status: 502 })
      }),
    )

    await expect(embedMultimodal([text(0)], { config })).rejects.toThrow(
      "failed after 3 attempt(s): 502",
    )
    expect(calls).toBe(3)
  })

  it("does not retry a 4xx other than 429", async () => {
    let calls = 0
    server.use(
      http.post(URL, () => {
        calls += 1
        return new HttpResponse("bad model", { status: 400 })
      }),
    )

    await expect(embedMultimodal([text(0)], { config })).rejects.toThrow("400")
    expect(calls).toBe(1)
  })
})
