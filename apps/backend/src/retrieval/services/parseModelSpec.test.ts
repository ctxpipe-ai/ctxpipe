import { describe, expect, it } from "vitest"

import {
  mergeModelParams,
  paramsToModelParams,
} from "./modelParams.js"
import {
  modelParamsFromSpec,
  modelSpecBase,
  parseModelSpec,
} from "./parseModelSpec.js"

describe("parseModelSpec", () => {
  it("parses model id without query", () => {
    expect(parseModelSpec("openai/gpt-5.5")).toEqual({
      modelId: "openai/gpt-5.5",
      params: {},
    })
  })

  it("parses Bedrock dot id with reasoning.effort", () => {
    expect(parseModelSpec("openai.gpt-5.5?reasoning.effort=medium")).toEqual({
      modelId: "openai.gpt-5.5",
      params: { "reasoning.effort": "medium" },
    })
  })

  it("parses multiple query params", () => {
    expect(
      parseModelSpec(
        "openai.gpt-5.5?reasoning.effort=high&text.verbosity=low",
      ),
    ).toEqual({
      modelId: "openai.gpt-5.5",
      params: {
        "reasoning.effort": "high",
        "text.verbosity": "low",
      },
    })
  })

  it("modelSpecBase strips query only", () => {
    expect(modelSpecBase("openai/gpt-5.5?reasoning.effort=low")).toBe(
      "openai/gpt-5.5",
    )
    expect(modelSpecBase("openai.gpt-5.5?reasoning.effort=low")).toBe(
      "openai.gpt-5.5",
    )
  })
})

describe("paramsToModelParams", () => {
  it("nests and validates canonical dot keys", () => {
    expect(
      paramsToModelParams({
        "reasoning.effort": "low",
        "text.verbosity": "medium",
      }),
    ).toEqual({
      reasoning: { effort: "low" },
      text: { verbosity: "medium" },
    })
  })

  it("rejects invalid reasoning.effort", () => {
    expect(() =>
      paramsToModelParams({ "reasoning.effort": "invalid" }),
    ).toThrow(/Invalid model spec params/)
  })

  it("rejects unknown top-level keys", () => {
    expect(() => paramsToModelParams({ "foo.bar": "baz" })).toThrow(
      /Unknown model spec param/,
    )
  })

  it("parses provider namespace keys", () => {
    expect(
      paramsToModelParams({
        "openrouter.provider.order": "openai",
      }),
    ).toEqual({
      openrouter: { provider: { order: "openai" } },
    })
  })
})

describe("mergeModelParams", () => {
  it("deep merges nested objects", () => {
    expect(
      mergeModelParams(
        { reasoning: { effort: "medium" } },
        { reasoning: { effort: "none" } },
      ),
    ).toEqual({ reasoning: { effort: "none" } })
  })
})

describe("modelParamsFromSpec", () => {
  it("returns empty object when spec has no query", () => {
    expect(modelParamsFromSpec("openai/gpt-5.5")).toEqual({})
  })

  it("parses full spec", () => {
    expect(
      modelParamsFromSpec("openai/gpt-5.5?reasoning.effort=high"),
    ).toEqual({
      reasoning: { effort: "high" },
    })
  })
})
