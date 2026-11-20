import { HttpResponse, http } from "msw"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import { decideNoul } from "./client.js"

const DECISIONS = "https://jev-gateway.test/api/alpha/decisions"

const server = useMswServer()
const spans = recordSpans()

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER_URL", "https://jev-gateway.test/api/v1")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
})

const question = { type: "noul" as const, instructions: "Is the sky blue?" }

describe("decideNoul", () => {
  it("sends the yes/no questions in one no-retention call and returns the probability of yes", async () => {
    let body: unknown
    server.use(
      http.post(DECISIONS, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          answers: {
            sky: { type: "noul", noul: 0.7 },
          },
          usage: { cost: 0.002 },
        })
      }),
    )

    const answers = await decideNoul(
      ["The state."],
      { sky: question },
      { timeoutMs: 5_000, attributes: { "jev.pairs": 1 } },
    )

    expect(answers).toEqual(new Map([["sky", 0.7]]))
    expect(body).toEqual({
      model: "typesafe/jev-1.14",
      state: ["The state."],
      questions: { sky: question },
      provider: { data_collection: "deny", zdr: true },
    })
    const span = spans.spanNamed("jev.decide")
    expect(span?.attributes["jev.pairs"]).toBe(1)
    expect(span?.attributes["gen_ai.usage.cost"]).toBe(0.002)
  })

  it("throws an invalid-answer JevError when an answer has no probability", async () => {
    server.use(
      http.post(DECISIONS, () =>
        HttpResponse.json({ answers: { sky: { type: "noul" } } }),
      ),
    )

    await expect(
      decideNoul(
        ["The state."],
        { sky: question },
        { timeoutMs: 5_000, attributes: {} },
      ),
    ).rejects.toMatchObject({ name: "JevError", kind: "invalid-answer" })
    expect(spans.spanNamed("jev.decide")?.attributes["jev.error_kind"]).toBe(
      "invalid-answer",
    )
  })

  it("keeps a fixed routing message of the gateway in the error, and no other error text", async () => {
    server.use(
      http.post(DECISIONS, () =>
        HttpResponse.json(
          {
            error: {
              message: "No endpoints found matching your data policy.",
            },
          },
          { status: 404 },
        ),
      ),
    )
    const decide = () =>
      decideNoul(
        ["The state."],
        { sky: question },
        { timeoutMs: 5_000, attributes: {} },
      )

    await expect(decide()).rejects.toMatchObject({
      kind: "http",
      status: 404,
      message:
        "Jev answered HTTP 404: No endpoints found matching your data policy.",
    })

    server.use(
      http.post(DECISIONS, () =>
        HttpResponse.json(
          { error: { message: "Bad state: The state." } },
          { status: 400 },
        ),
      ),
    )
    await expect(decide()).rejects.toMatchObject({
      message: "Jev answered HTTP 400.",
    })
  })
})
