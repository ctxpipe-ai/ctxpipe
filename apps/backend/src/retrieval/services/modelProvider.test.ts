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

const chatBedrockConverseConstructor = vi.hoisted(() => {
  class MockChatBedrockConverse {
    readonly fields: unknown
    constructor(fields: unknown) {
      this.fields = fields
    }
  }
  return vi.fn(MockChatBedrockConverse)
})

const mockBedrockSend = vi.hoisted(() => vi.fn())

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: chatOpenAIConstructor,
}))

vi.mock("@langchain/aws", () => ({
  ChatBedrockConverse: chatBedrockConverseConstructor,
}))

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class MockInvokeModelCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  class MockBedrockRuntimeClient {
    send = mockBedrockSend
    constructor(_config: unknown) {}
  }
  return {
    BedrockRuntimeClient: MockBedrockRuntimeClient,
    InvokeModelCommand: MockInvokeModelCommand,
  }
})

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
    chatOpenAIConstructor.mockClear()
    chatBedrockConverseConstructor.mockClear()
    mockBedrockSend.mockReset()
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

  it("getModel constructs native Bedrock chat without MODEL_PROVIDER_URL", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    delete process.env.MODEL_PROVIDER_API_KEY
    delete process.env.MODEL_PROVIDER_URL
    process.env.MODEL_BEDROCK_AWS_REGION = "us-east-1"
    process.env.MODEL_MEDIUM_NAME = "openai.gpt-5.5?reasoning.effort=medium"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium")

    expect(chatOpenAIConstructor).not.toHaveBeenCalled()
    expect(chatBedrockConverseConstructor).toHaveBeenCalled()
    const call = chatBedrockConverseConstructor.mock.calls[0]?.[0] as {
      model?: string
      region?: string
      additionalModelRequestFields?: { reasoning_effort?: string }
    }
    expect(call?.model).toBe("openai.gpt-5.5")
    expect(call?.region).toBe("us-east-1")
    expect(call?.additionalModelRequestFields?.reasoning_effort).toBe("medium")
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

  it("getModel merges reasoning.effort=none when reasoning false on Bedrock", async () => {
    process.env.MODEL_PROVIDER = "bedrock"
    process.env.MODEL_BEDROCK_AWS_REGION = "us-east-1"
    process.env.MODEL_MEDIUM_NAME =
      "openai.gpt-5.5?reasoning.effort=medium"
    vi.resetModules()
    const { getModel } = await import("./modelProvider.js")
    getModel("medium", { reasoning: false })

    const call = chatBedrockConverseConstructor.mock.calls[0]?.[0] as {
      additionalModelRequestFields?: { reasoning_effort?: string }
    }
    expect(call?.additionalModelRequestFields?.reasoning_effort).toBe("none")
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
