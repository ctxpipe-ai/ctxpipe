import { describe, expect, it } from "vitest"

import {
  lowerOpenAiChatCompletionsParams,
  lowerOpenRouterParams,
} from "./lowerModelParams.js"

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

describe("lowerOpenRouterParams", () => {
  it("keeps reasoning nested", () => {
    expect(
      lowerOpenRouterParams({
        reasoning: { effort: "medium" },
      }),
    ).toEqual({ reasoning: { effort: "medium" } })
  })

  it("maps text.verbosity to top-level verbosity", () => {
    expect(
      lowerOpenRouterParams({
        text: { verbosity: "high" },
      }),
    ).toEqual({ verbosity: "high" })
  })

  it("merges openrouter namespace into request kwargs", () => {
    expect(
      lowerOpenRouterParams({
        openrouter: { provider: { sort: "latency" } },
      }),
    ).toEqual({ provider: { sort: "latency" } })
  })
})
