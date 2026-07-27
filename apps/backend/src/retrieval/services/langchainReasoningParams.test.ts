import { ChatOpenAI } from "@langchain/openai"
import { describe, expect, it } from "vitest"

describe("LangChain reasoning request params", () => {
  it("passes explicit reasoning_effort through for provider-prefixed Chat Completions models", () => {
    const model = new ChatOpenAI({
      model: "openai.gpt-5.5",
      apiKey: "test-key",
      modelKwargs: { reasoning_effort: "medium" },
      configuration: { baseURL: "http://127.0.0.1:1/v1" },
    })

    expect(model.invocationParams()).toMatchObject({
      model: "openai.gpt-5.5",
      reasoning_effort: "medium",
    })
  })

  it("does not translate nested reasoning from modelKwargs", () => {
    const model = new ChatOpenAI({
      model: "openai.gpt-5.5",
      apiKey: "test-key",
      modelKwargs: { reasoning: { effort: "medium" } },
      configuration: { baseURL: "http://127.0.0.1:1/v1" },
    })

    expect(model.invocationParams()).toMatchObject({
      model: "openai.gpt-5.5",
      reasoning: { effort: "medium" },
    })
    expect(model.invocationParams()).not.toHaveProperty("reasoning_effort")
  })
})
