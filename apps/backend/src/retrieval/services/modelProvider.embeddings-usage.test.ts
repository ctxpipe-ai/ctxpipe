import { trace } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { generateEmbeddings } from "./modelProvider.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "deployment.environment": "test",
  }),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

const server = useMswServer()

function generationInputTokens(): unknown {
  const generation = exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.name === "modelProvider.generateEmbeddings" &&
        span.attributes["gen_ai.operation.name"] === "embeddings",
    )
  return generation?.attributes["gen_ai.usage.input_tokens"]
}

describe("generateEmbeddings span usage", () => {
  beforeAll(() => {
    trace.disable()
    provider.register()
  })

  beforeEach(() => {
    exporter.reset()
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "k")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://api.openai.com/v1")
    vi.stubEnv("MODEL_EMBEDDING_NAME", "openai/text-embedding-3-large")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await provider.shutdown()
    trace.disable()
  })

  it("puts the gateway cost of the call on the generation span", async () => {
    server.use(
      http.post("https://api.openai.com/v1/embeddings", async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array(2000).fill(0.01),
          })),
          model: "text-embedding-3-large",
          usage: { prompt_tokens: 8, total_tokens: 8, cost: 0.0002 },
        })
      }),
    )

    await generateEmbeddings(["hello"])
    const generation = exporter
      .getFinishedSpans()
      .find((span) => span.name === "modelProvider.generateEmbeddings")
    expect(generation?.attributes).toMatchObject({
      "gen_ai.operation.name": "embeddings",
      "gen_ai.request.model": "openai/text-embedding-3-large",
      "gen_ai.provider.name": "openai-like",
      "gen_ai.input.messages": JSON.stringify({
        textCount: 1,
        totalCharacters: 5,
      }),
      "gen_ai.usage.cost": 0.0002,
      "gen_ai.usage.input_tokens": 8,
    })
  })

  it("keeps the cost of the batches before a failed one", async () => {
    let calls = 0
    server.use(
      http.post("https://api.openai.com/v1/embeddings", async ({ request }) => {
        calls += 1
        if (calls > 1)
          return HttpResponse.text("upstream error", { status: 502 })
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array(2000).fill(0.01),
          })),
          model: "text-embedding-3-large",
          usage: { prompt_tokens: 64, total_tokens: 64, cost: 0.0003 },
        })
      }),
    )

    // 65 texts: one full batch of 64, then a batch of 1 that fails.
    await expect(
      generateEmbeddings(Array.from({ length: 65 }, (_, i) => `text ${i}`)),
    ).rejects.toThrow("Embedding failed: 502")
    const generation = exporter
      .getFinishedSpans()
      .find((span) => span.name === "modelProvider.generateEmbeddings")
    expect(generation?.attributes["gen_ai.usage.cost"]).toBe(0.0003)
    expect(generation?.attributes["gen_ai.usage.input_tokens"]).toBe(64)
  })

  it("copies the provider prompt tokens onto the generation", async () => {
    server.use(
      http.post("https://api.openai.com/v1/embeddings", async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array(2000).fill(0.01),
          })),
          model: "text-embedding-3-large",
          usage: { prompt_tokens: 8, total_tokens: 8 },
        })
      }),
    )

    const embeddings = await generateEmbeddings(["hello"])
    expect(embeddings).toHaveLength(1)
    expect(generationInputTokens()).toBe(8)
  })

  it("omits usage details when the provider response has no usage", async () => {
    server.use(
      http.post("https://api.openai.com/v1/embeddings", async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array(2000).fill(0.01),
          })),
          model: "text-embedding-3-large",
        })
      }),
    )

    await generateEmbeddings(["hello"])
    expect(generationInputTokens()).toBeUndefined()
  })

  it("sums provider usage across embedding batches", async () => {
    const texts = Array.from({ length: 65 }, (_, index) => `t${index}`)
    server.use(
      http.post("https://api.openai.com/v1/embeddings", async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array(2000).fill(0.01),
          })),
          model: "text-embedding-3-large",
          usage:
            body.input.length === 64
              ? { prompt_tokens: 64, total_tokens: 64 }
              : { prompt_tokens: 3, total_tokens: 3 },
        })
      }),
    )

    const embeddings = await generateEmbeddings(texts)
    expect(embeddings).toHaveLength(65)
    expect(generationInputTokens()).toBe(67)
  })
})
