import type { Mock } from "vitest"
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

const mockProvideToken = vi.hoisted(() => vi.fn(async () => "mock-bedrock-token"))
const getTokenProvider = vi.hoisted(() => vi.fn(() => mockProvideToken))

vi.mock("@aws/bedrock-token-generator", () => ({
  getTokenProvider,
}))

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
    getTokenProvider.mockClear()
    mockProvideToken.mockClear()
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
    process.env.MODEL_FAST_NAME = "m-fast?reasoning.effort=low"
    process.env.MODEL_MEDIUM_NAME = "m-med?reasoning.effort=medium"
    process.env.MODEL_HIGH_NAME = "m-high?reasoning.effort=high"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    expect(chatOpenAIConstructor).toHaveBeenCalled()
    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: {
        plugins?: unknown[]
        models?: string[]
        reasoning?: { effort?: string }
      }
    }
    expect(call?.model).toBe("m-med")
    expect(call?.modelKwargs?.models).toEqual(["m-fast", "m-high"])
    expect(call?.modelKwargs?.plugins).toEqual([{ id: "context-compression" }])
    expect(call?.modelKwargs?.reasoning).toEqual({ effort: "medium" })
  })

  it("getModel passes tier fallback order to OpenRouter (fast: med then high)", async () => {
    process.env.MODEL_PROVIDER = "openrouter"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    process.env.MODEL_FAST_NAME = "m-fast"
    process.env.MODEL_MEDIUM_NAME = "m-med"
    process.env.MODEL_HIGH_NAME = "m-high"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("fast")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: { models?: string[] }
    }
    expect(call?.model).toBe("m-fast")
    expect(call?.modelKwargs?.models).toEqual(["m-med", "m-high"])
  })

  it("getModel dedupes identical model ids in OpenRouter fallback chain", async () => {
    process.env.MODEL_PROVIDER = "openrouter"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    process.env.MODEL_FAST_NAME = "same-model"
    process.env.MODEL_MEDIUM_NAME = "same-model"
    process.env.MODEL_HIGH_NAME = "m-high"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: { models?: string[] }
    }
    expect(call?.model).toBe("same-model")
    expect(call?.modelKwargs?.models).toEqual(["m-high"])
  })

  it("getModel lowers canonical params for openai-like", async () => {
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://api.openai.com/v1"
    process.env.MODEL_MEDIUM_NAME =
      "openai/gpt-5.5?reasoning.effort=medium&text.verbosity=low"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: { reasoning_effort?: string; verbosity?: string }
    }
    expect(call?.model).toBe("openai/gpt-5.5")
    expect(call?.modelKwargs?.reasoning_effort).toBe("medium")
    expect(call?.modelKwargs?.verbosity).toBe("low")
  })

  it("getModel omits OpenRouter extras when MODEL_PROVIDER=openai-like", async () => {
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    process.env.MODEL_FAST_NAME = "m-fast"
    process.env.MODEL_MEDIUM_NAME = "m-med"
    process.env.MODEL_HIGH_NAME = "m-high"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: unknown
    }
    expect(call?.model).toBe("m-med")
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

    const fetchMock = globalThis.fetch as unknown as Mock
    expect(fetchMock).toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = init.headers as Headers
    expect(sent.get("api-key")).toBe("azure-key")
    expect(sent.has("Authorization")).toBe(false)
  })

  it("generateEmbedding sends Bearer for MODEL_PROVIDER=bedrock with API key", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    process.env.MODEL_PROVIDER_API_KEY = "bedrock-token"
    process.env.MODEL_PROVIDER_URL =
      "https://bedrock-mantle.us-east-1.api.aws/v1"
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    const fetchMock = globalThis.fetch as unknown as Mock
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer bedrock-token",
    )
  })

  it("getModel uses Bedrock task-role bearer when MODEL_PROVIDER=bedrock without API key", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    delete process.env.MODEL_PROVIDER_API_KEY
    process.env.MODEL_PROVIDER_URL =
      "https://bedrock-mantle.us-east-1.api.aws/v1"
    process.env.MODEL_FAST_NAME = "m-fast"
    process.env.MODEL_MEDIUM_NAME = "m-med"
    process.env.MODEL_HIGH_NAME = "m-high"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    expect(getTokenProvider).toHaveBeenCalledWith({ region: "us-east-1" })
    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      configuration?: { fetch?: (input: string, init?: RequestInit) => Promise<Response> }
    }
    const bedrockFetch = call?.configuration?.fetch
    expect(bedrockFetch).toBeDefined()

    await bedrockFetch?.("https://example.com/v1/chat/completions", {
      method: "POST",
    })
    const fetchMock = globalThis.fetch as unknown as Mock
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer mock-bedrock-token",
    )
  })

  it("generateEmbedding uses Bedrock task-role bearer when no API key", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    delete process.env.MODEL_PROVIDER_API_KEY
    process.env.MODEL_PROVIDER_URL =
      "https://bedrock-mantle.us-west-2.api.aws/v1"
    vi.resetModules()
    const { generateEmbedding } = await import("./modelProvider.js")
    await generateEmbedding("hello")

    expect(getTokenProvider).toHaveBeenCalledWith({ region: "us-west-2" })
    const fetchMock = globalThis.fetch as unknown as Mock
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer mock-bedrock-token",
    )
  })

  it("getModel passes reasoning.effort from slash default specs on OpenRouter", async () => {
    process.env.MODEL_PROVIDER = "openrouter"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    delete process.env.MODEL_FAST_NAME
    delete process.env.MODEL_MEDIUM_NAME
    delete process.env.MODEL_HIGH_NAME
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("fast")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: { reasoning?: { effort?: string } }
    }
    expect(call?.model).toBe("openai/gpt-5.5")
    expect(call?.modelKwargs?.reasoning).toEqual({ effort: "low" })
  })

  it("getModel passes Bedrock dot model id and effort without remapping", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    delete process.env.MODEL_PROVIDER_API_KEY
    process.env.MODEL_PROVIDER_URL =
      "https://bedrock-mantle.us-east-1.api.aws/v1"
    process.env.MODEL_MEDIUM_NAME =
      "openai.gpt-5.5?reasoning.effort=medium"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      model?: string
      modelKwargs?: { reasoning_effort?: string }
    }
    expect(call?.model).toBe("openai.gpt-5.5")
    expect(call?.modelKwargs?.reasoning_effort).toBe("medium")
  })

  it("getModel merges reasoning.effort=none when reasoning false on OpenRouter", async () => {
    process.env.MODEL_PROVIDER = "openrouter"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://openrouter.ai/api/v1"
    process.env.MODEL_MEDIUM_NAME =
      "openai/gpt-5.5?reasoning.effort=medium"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium", { reasoning: false })

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      modelKwargs?: { reasoning?: { effort?: string } }
    }
    expect(call?.modelKwargs?.reasoning).toEqual({ effort: "none" })
  })

  it("getModel merges reasoning.effort=none when reasoning false on openai-like", async () => {
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "k"
    process.env.MODEL_PROVIDER_URL = "https://api.openai.com/v1"
    process.env.MODEL_MEDIUM_NAME =
      "openai/gpt-5.5?reasoning.effort=medium"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium", { reasoning: false })

    const call = chatOpenAIConstructor.mock.calls[0]?.[0] as {
      modelKwargs?: { reasoning_effort?: string }
    }
    expect(call?.modelKwargs?.reasoning_effort).toBe("none")
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
})
