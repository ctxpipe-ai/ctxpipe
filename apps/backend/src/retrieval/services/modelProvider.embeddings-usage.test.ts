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
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { generateEmbeddings } from "./modelProvider.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "deployment.environment": "test",
  }),
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
})

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

function generationUsageDetails(): unknown {
  const generation = exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.name === "modelProvider.generateEmbeddings" &&
        span.attributes["langfuse.observation.type"] === "generation",
    )
  const raw = generation?.attributes["langfuse.observation.usage_details"]
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

describe("generateEmbeddings Langfuse usage", () => {
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

  it("copies provider prompt and total tokens onto the generation", async () => {
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
    expect(generationUsageDetails()).toEqual({ input: 8, total: 8 })
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
    expect(generationUsageDetails()).toBeUndefined()
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
    expect(generationUsageDetails()).toEqual({ input: 67, total: 67 })
  })
})
