import { describe, expect, it } from "vitest"
import { scoreAnswer } from "./advisorEval.js"

describe("scoreAnswer", () => {
  it("passes when every ADR is cited in any form and every term is stated", () => {
    expect(
      scoreAnswer("Per ADR-002 and ADR 10, the backend runs on **Bun**.", {
        adrs: [2, 10],
        terms: ["bun", "Node|runs on"],
      }),
    ).toMatchObject({ pass: true, citedAdrs: [2, 10] })
  })

  it("reports what is missing", () => {
    expect(
      scoreAnswer("ADR-001 is the UI stack.", {
        adrs: [1, 9],
        terms: ["Tailwind"],
      }),
    ).toMatchObject({
      pass: false,
      missingAdrs: [9],
      missingTerms: ["Tailwind"],
    })
  })

  it("needs each supersession pair on one line", () => {
    const answer = [
      "- ADR-004: superseded; replacement not identified",
      "- ADR-021: superseded by ADR-024",
      "ADR-015 covers Compose profiles.",
    ].join("\n")
    expect(
      scoreAnswer(answer, {
        pairs: [
          [15, 4],
          [24, 21],
        ],
      }),
    ).toMatchObject({ pass: false, missingPairs: ["ADR-15/ADR-4"] })
  })
})
