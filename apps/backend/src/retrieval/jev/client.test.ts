import { HttpResponse, http } from "msw"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import { decideChoice } from "./client.js"

const DECISIONS = "https://jev-gateway.test/api/alpha/decisions"

const server = useMswServer()
const spans = recordSpans()

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER_URL", "https://jev-gateway.test/api/v1")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
})

const question = {
  type: "choice" as const,
  instructions: "Is the sky blue or gray?",
  criteria: { blue: "The sky is blue.", gray: "The sky is gray." },
}

describe("decideChoice", () => {
  it("sends the choice questions in one pinned, no-retention call and returns the probability of each option", async () => {
    let body: unknown
    server.use(
      http.post(DECISIONS, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          answers: {
            sky: {
              type: "choice",
              probabilities: { blue: 0.7, gray: 0.3 },
            },
          },
          usage: { cost: 0.002 },
        })
      }),
    )

    const answers = await decideChoice(
      ["The state."],
      { sky: question },
      { timeoutMs: 5_000, attributes: { "jev.pairs": 1 } },
    )

    expect(answers).toEqual(new Map([["sky", { blue: 0.7, gray: 0.3 }]]))
    expect(body).toEqual({
      model: "typesafe/jev-1.14",
      state: ["The state."],
      questions: { sky: question },
      provider: {
        data_collection: "deny",
        order: ["typesafe"],
        allow_fallbacks: false,
        zdr: true,
      },
    })
    const span = spans.spanNamed("jev.decide")
    expect(span?.attributes["jev.pairs"]).toBe(1)
    expect(span?.attributes["gen_ai.usage.cost"]).toBe(0.002)
  })

  it("throws an invalid-answer JevError when an option has no probability", async () => {
    server.use(
      http.post(DECISIONS, () =>
        HttpResponse.json({
          answers: { sky: { type: "choice", probabilities: { blue: 0.7 } } },
        }),
      ),
    )

    await expect(
      decideChoice(
        ["The state."],
        { sky: question },
        { timeoutMs: 5_000, attributes: {} },
      ),
    ).rejects.toMatchObject({ name: "JevError", kind: "invalid-answer" })
    expect(spans.spanNamed("jev.decide")?.attributes["jev.error_kind"]).toBe(
      "invalid-answer",
    )
  })
})
