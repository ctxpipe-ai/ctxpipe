import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const chatOpenAIConstructor = vi.hoisted(() => {
  class MockChatOpenAI {
    readonly fields: unknown
    constructor(fields: unknown) {
      this.fields = fields
    }
  }
  return vi.fn(MockChatOpenAI)
})

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: chatOpenAIConstructor,
}))

function fakeEmbeddingResponse(): Response {
  const embedding = new Array(2000).fill(0.01)
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("modelProvider", () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    chatOpenAIConstructor.mockClear()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeEmbeddingResponse()))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...savedEnv }
  })

  it("getModel uses OpenRouter extras only when MODEL_PROVIDER=openrouter", async () => {
    process.env.MODEL_PROVIDER = "openrouter"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    expect(chatOpenAIConstructor).toHaveBeenCalled()
    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      modelKwargs?: { plugins?: unknown[] }
    }
    expect(call?.modelKwargs?.plugins).toEqual([{ id: "context-compression" }])
  })

  it("getModel omits OpenRouter extras when MODEL_PROVIDER=openai-like", async () => {
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      modelKwargs?: unknown
    }
    expect(call?.modelKwargs).toBeUndefined()
  })

  it("generateEmbedding sends api-key for MODEL_PROVIDER=azure", async () => {
    process.env.MODEL_PROVIDER = "azure"
    process.env.MODEL_PROVIDER_API_KEY = "azure-key"
    process.env.MODEL_PROVIDER_URL =
      "https://example.openai.azure.com/openai/deployments/foo"
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      "api-key": "azure-key",
    })
    expect(init.headers).not.toHaveProperty("Authorization")
  })

  it("generateEmbedding sends Bearer for MODEL_PROVIDER=bedrock with API key", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    process.env.MODEL_PROVIDER_API_KEY = "bedrock-token"
    process.env.MODEL_PROVIDER_URL =
      "https://bedrock-mantle.us-east-1.api.aws/v1"
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      Authorization: "Bearer bedrock-token",
    })
  })
})
