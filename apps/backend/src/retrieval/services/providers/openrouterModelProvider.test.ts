import { describe, expect, it } from "vitest"

import { lowerOpenRouterParams } from "./openrouterModelProvider.js"

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
