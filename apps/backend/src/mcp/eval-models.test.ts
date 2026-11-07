import { describe, expect, it } from "vitest"

import { openRouterClient } from "../../evals/mcp/models.js"

describe("openRouterClient", () => {
  it("uses OpenRouter and the model provider key by default", () => {
    const client = openRouterClient("openai/gpt-5", {
      MODEL_PROVIDER_API_KEY: "k",
    })
    expect(client.apiKey).toBe("k")
    expect(client.sdkModel).toBe("openrouter-eval/openai/gpt-5")
    expect(client.customProviders["openrouter-eval"]?.baseUrl).toBe(
      "https://openrouter.ai/api/v1",
    )
  })
  it("uses MODEL_PROVIDER_URL when set", () => {
    const client = openRouterClient("anthropic/claude-sonnet-4-5", {
      MODEL_PROVIDER_API_KEY: "k",
      MODEL_PROVIDER_URL: "http://gateway.test/v1",
    })
    expect(client.customProviders["openrouter-eval"]?.baseUrl).toBe(
      "http://gateway.test/v1",
    )
    expect(client.sdkModel).toBe("openrouter-eval/anthropic/claude-sonnet-4.5")
  })
  it("fails clearly without a key", () => {
    expect(() => openRouterClient("openai/gpt-5", {})).toThrow(
      /MODEL_PROVIDER_API_KEY/,
    )
  })
})
