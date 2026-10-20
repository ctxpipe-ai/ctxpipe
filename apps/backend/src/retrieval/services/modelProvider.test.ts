import type { Mock } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockBedrockSend = vi.hoisted(() => vi.fn())
const withLangfuseGenerationMock = vi.hoisted(() =>
  vi.fn((_attrs: unknown, fn: () => unknown) => fn()),
)

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class MockInvokeModelCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  class MockBedrockRuntimeClient {
    send = mockBedrockSend
  }
  return {
    BedrockRuntimeClient: MockBedrockRuntimeClient,
    InvokeModelCommand: MockInvokeModelCommand,
  }
})

vi.mock("../../observability/langfuse.js", () => ({
  withLangfuseGeneration: withLangfuseGenerationMock,
}))

function fakeEmbeddingResponse(): Response {
  const embedding = new Array(2000).fill(0.01)
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function fakeCohereEmbedResponse(dimensions = 1536): Uint8Array {
  const embedding = new Array(dimensions).fill(0.02)
  return new TextEncoder().encode(
    JSON.stringify({ embeddings: { float: [embedding] } }),
  )
}

describe("modelProvider", () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    mockBedrockSend.mockReset()
    withLangfuseGenerationMock.mockClear()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeEmbeddingResponse()))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...savedEnv }
  })

  it("generateEmbedding sends api-key for MODEL_PROVIDER=azure", async () => {
    process.env.MODEL_PROVIDER = "azure"
    process.env.MODEL_PROVIDER_API_KEY = "azure-key"
    process.env.MODEL_PROVIDER_URL =
      "https://example.openai.azure.com/openai/deployments/foo"
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    const fetchMock = globalThis.fetch as unknown as Mock
    expect(fetchMock).toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = init.headers as Headers
    expect(sent.get("api-key")).toBe("azure-key")
    expect(sent.has("Authorization")).toBe(false)
  })

  it("generateEmbedding uses native Bedrock InvokeModel for bedrock", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    delete process.env.MODEL_PROVIDER_API_KEY
    process.env.MODEL_BEDROCK_AWS_REGION = "us-west-2"
    process.env.MODEL_EMBEDDING_NAME = "cohere.embed-v4:0"
    mockBedrockSend.mockResolvedValue({ body: fakeCohereEmbedResponse() })
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    const embedding = await generateEmbedding("hello")

    expect(mockBedrockSend).toHaveBeenCalled()
    const command = mockBedrockSend.mock.calls[0]?.[0] as {
      input?: { modelId?: string; body?: string }
    }
    expect(command.input?.modelId).toBe("cohere.embed-v4:0")
    const body = JSON.parse(String(command.input?.body)) as {
      texts?: string[]
      output_dimension?: number
    }
    expect(body.texts).toEqual(["hello"])
    expect(body.output_dimension).toBe(1536)
    expect(embedding).toHaveLength(2000)
  })

  it("generateEmbedding keeps inference-profile model id and cohere settings", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    delete process.env.MODEL_PROVIDER_API_KEY
    process.env.MODEL_BEDROCK_AWS_REGION = "us-west-2"
    process.env.MODEL_EMBEDDING_NAME = "global.cohere.embed-v4:0"
    mockBedrockSend.mockResolvedValue({ body: fakeCohereEmbedResponse() })
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    const command = mockBedrockSend.mock.calls[0]?.[0] as {
      input?: { modelId?: string; body?: string }
    }
    expect(command.input?.modelId).toBe("global.cohere.embed-v4:0")
    const body = JSON.parse(String(command.input?.body)) as {
      output_dimension?: number
    }
    expect(body.output_dimension).toBe(1536)
  })

  it("generateEmbedding strips query params from embedding model name", async () => {
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://api.openai.com/v1"
    process.env.MODEL_EMBEDDING_NAME =
      "openai/text-embedding-3-large?dimensions=2000"
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    const fetchMock = globalThis.fetch as unknown as Mock
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { model?: string }
    expect(body.model).toBe("openai/text-embedding-3-large")
  })

  it("generateEmbeddings posts input as a string array in one request", async () => {
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://api.openai.com/v1"
    const embA = new Array(2000).fill(0.1)
    const embB = new Array(2000).fill(0.2)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { embedding: embA, index: 0 },
              { embedding: embB, index: 1 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )
    vi.resetModules()
    const { generateEmbeddings } = await import("./modelProvider.js")
    const out = await generateEmbeddings(["a", "b"])

    const fetchMock = globalThis.fetch as unknown as Mock
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { input?: unknown }
    expect(body.input).toEqual(["a", "b"])
    expect(out).toHaveLength(2)
    expect(out[0]?.[0]).toBe(0.1)
    expect(out[1]?.[0]).toBe(0.2)
    expect(withLangfuseGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "modelProvider.generateEmbeddings",
        model: "openai/text-embedding-3-large",
        input: {
          textCount: 2,
          totalCharacters: 2,
        },
        metadata: expect.objectContaining({
          provider: "openai-like",
          embeddingModel: "openai/text-embedding-3-large",
          dimensions: 2000,
        }),
      }),
      expect.any(Function),
    )
  })
})
