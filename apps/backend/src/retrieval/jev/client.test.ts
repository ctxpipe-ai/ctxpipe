import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import { decideNoul } from "./client.js"

const DECISIONS = "https://jev-gateway.test/api/alpha/decisions"

const server = useMswServer()
const spans = recordSpans()

beforeEach(() => {
  for (const name of [
    "DECISION_MODEL_PROVIDER",
    "DECISION_MODEL_NAME",
    "DECISION_MODEL_URL",
    "DECISION_MODEL_API_KEY",
    "MODEL_PROVIDER_ALLOWLIST",
  ])
    vi.stubEnv(name, "")
  vi.stubEnv("MODEL_PROVIDER", "")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://jev-gateway.test/api/v1")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
})
afterEach(() => {
  vi.unstubAllEnvs()
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

  describe("a slow call", () => {
    // Only the timers of the hedge and of msw: the time limit is real.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    })
    afterEach(async () => {
      // Run the timers that started on the fake clock (also those of the
      // span processor) before the real clock comes back.
      await vi.runOnlyPendingTimersAsync()
      vi.useRealTimers()
    })

    /**
     * Each request to the endpoint, in order. A request answers when the test
     * calls `answer` (a response, or "error" for a network error), or never.
     * `arrived(n)` waits until the endpoint has `n` requests.
     */
    function endpoint() {
      const requests: {
        body: unknown
        signal: AbortSignal
        answer: (response: Response | "error") => void
      }[] = []
      const waiting: (() => void)[] = []
      server.use(
        http.post(DECISIONS, async ({ request }) => {
          const body = await request.json()
          const response = await new Promise<Response | "error">((answer) => {
            requests.push({ body, signal: request.signal, answer })
            for (const wake of waiting.splice(0)) wake()
          })
          return response === "error" ? HttpResponse.error() : response
        }),
      )
      const arrived = async (n: number) => {
        while (requests.length < n)
          await new Promise<void>((wake) => waiting.push(wake))
      }
      return { requests, arrived }
    }
    const yes = (p: number) =>
      HttpResponse.json({ answers: { sky: { type: "noul", noul: p } } })
    const decide = (timeoutMs = 5_000) =>
      decideNoul(
        ["The state."],
        { sky: question },
        { timeoutMs, attributes: {} },
      )

    it("sends a second copy after 700 ms, takes the first answer and stops the other copy", async () => {
      const { requests, arrived } = endpoint()
      const call = decide()
      await arrived(1)
      await vi.advanceTimersByTimeAsync(699)
      expect(requests).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await arrived(2)
      expect(requests[1]?.body).toEqual(requests[0]?.body)

      requests[1]?.answer(yes(0.9))

      expect(await call).toEqual(new Map([["sky", 0.9]]))
      expect(requests[0]?.signal.aborted).toBe(true)
      const span = spans.spanNamed("jev.decide")
      expect(span?.attributes["jev.hedged"]).toBe(true)
      expect(span?.attributes["jev.hedge_won"]).toBe(true)
    })

    it("takes the answer of the first copy when it ends before the second copy", async () => {
      const { requests, arrived } = endpoint()
      const call = decide()
      await arrived(1)
      await vi.advanceTimersByTimeAsync(700)
      await arrived(2)

      requests[0]?.answer(yes(0.1))

      expect(await call).toEqual(new Map([["sky", 0.1]]))
      expect(requests[1]?.signal.aborted).toBe(true)
      expect(spans.spanNamed("jev.decide")?.attributes["jev.hedge_won"]).toBe(
        false,
      )
    })

    it("fails when the second copy fails first, and stops the first copy: the copy is no retry", async () => {
      const { requests, arrived } = endpoint()
      const call = decide()
      await arrived(1)
      await vi.advanceTimersByTimeAsync(700)
      await arrived(2)

      requests[1]?.answer("error")

      await expect(call).rejects.toMatchObject({ kind: "network" })
      expect(requests[0]?.signal.aborted).toBe(true)
      expect(spans.spanNamed("jev.decide")?.attributes["jev.hedge_won"]).toBe(
        true,
      )
    })

    it("sends one request when the call answers before 700 ms", async () => {
      const { requests, arrived } = endpoint()
      const call = decide()
      await arrived(1)
      requests[0]?.answer(yes(0.7))
      await call
      await vi.advanceTimersByTimeAsync(1_000)

      expect(requests).toHaveLength(1)
      expect(spans.spanNamed("jev.decide")?.attributes["jev.hedged"]).toBe(
        false,
      )
    })

    it("throws a timeout JevError when no copy answers in the time limit", async () => {
      const { arrived } = endpoint()
      const call = decide(200)
      await arrived(1)
      await vi.advanceTimersByTimeAsync(700)
      await arrived(2)

      await expect(call).rejects.toMatchObject({
        name: "JevError",
        kind: "timeout",
      })
    })
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
        "The decision model answered HTTP 404: No endpoints found matching your data policy.",
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
      message: "The decision model answered HTTP 400.",
    })
  })

  describe("the decision model setting", () => {
    const ask = () =>
      decideNoul(
        ["The state."],
        { sky: question },
        { timeoutMs: 5_000, attributes: {} },
      )

    it("sends the questions to an OpenAI-compatible decisions endpoint with no OpenRouter field", async () => {
      vi.stubEnv("MODEL_PROVIDER", "bedrock")
      vi.stubEnv("DECISION_MODEL_PROVIDER", "openai")
      vi.stubEnv("DECISION_MODEL_URL", "https://decisions.test/v1")
      vi.stubEnv("DECISION_MODEL_API_KEY", "decision-key")
      let body: unknown
      let authorization: string | null = null
      server.use(
        http.post(
          "https://decisions.test/v1/decisions",
          async ({ request }) => {
            body = await request.json()
            authorization = request.headers.get("authorization")
            return HttpResponse.json({
              id: "dec_1",
              object: "decision",
              model: "gpt-6-luna",
              answers: [{ type: "predicate", name: "sky", probability: 0.8 }],
              usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
            })
          },
        ),
      )

      expect(await ask()).toEqual(new Map([["sky", 0.8]]))
      expect(authorization).toBe("Bearer decision-key")
      expect(body).toEqual({
        model: "gpt-6-luna",
        input: JSON.stringify(["The state."]),
        questions: [
          { type: "predicate", name: "sky", instructions: "Is the sky blue?" },
        ],
      })
      const span = spans.spanNamed("jev.decide")
      expect(span?.attributes["gen_ai.provider.name"]).toBe("openai")
      expect(span?.attributes["gen_ai.request.model"]).toBe("gpt-6-luna")
    })

    it("throws a config JevError for a decision provider that the backend does not support", async () => {
      vi.stubEnv("DECISION_MODEL_PROVIDER", "gemini")
      vi.stubEnv("DECISION_MODEL_API_KEY", "gemini-key")

      await expect(ask()).rejects.toMatchObject({
        name: "JevError",
        kind: "config",
      })
    })

    it("sends Jev on OpenRouter with the ZDR block when only a decision key is set", async () => {
      vi.stubEnv("MODEL_PROVIDER", "bedrock")
      vi.stubEnv("MODEL_PROVIDER_URL", "")
      vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
      vi.stubEnv("DECISION_MODEL_API_KEY", "openrouter-key")
      vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "typesafe")
      let body: unknown
      server.use(
        http.post(
          "https://openrouter.ai/api/alpha/decisions",
          async ({ request }) => {
            body = await request.json()
            return HttpResponse.json({
              answers: { sky: { type: "noul", noul: 0.6 } },
            })
          },
        ),
      )

      expect(await ask()).toEqual(new Map([["sky", 0.6]]))
      expect(body).toMatchObject({
        model: "typesafe/jev-1.14",
        provider: { data_collection: "deny", zdr: true, only: ["typesafe"] },
      })
    })

    it("throws a config JevError for a Bedrock install with no decision key", async () => {
      vi.stubEnv("MODEL_PROVIDER", "bedrock")

      await expect(ask()).rejects.toMatchObject({
        name: "JevError",
        kind: "config",
      })
    })
  })
})
