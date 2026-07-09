import { describe, expect, it } from "vitest"

import { lowerOpenAiChatCompletionsParams } from "./openAILikeModelProvider.js"

describe("lowerOpenAiChatCompletionsParams", () => {
  it("maps reasoning.effort to reasoning_effort", () => {
    expect(
      lowerOpenAiChatCompletionsParams({
        reasoning: { effort: "medium" },
      }),
    ).toEqual({ reasoning_effort: "medium" })
  })

  it("maps text.verbosity to verbosity", () => {
    expect(
      lowerOpenAiChatCompletionsParams({
        text: { verbosity: "low" },
      }),
    ).toEqual({ verbosity: "low" })
  })

  it("maps sampling params to OpenAI chat field names", () => {
    expect(
      lowerOpenAiChatCompletionsParams({
        sampling: { maxTokens: 100, topP: 0.9, seed: 42 },
      }),
    ).toEqual({
      max_tokens: 100,
      top_p: 0.9,
      seed: 42,
    })
  })
})
