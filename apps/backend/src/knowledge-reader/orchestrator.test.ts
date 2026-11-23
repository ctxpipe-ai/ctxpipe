import { HttpResponse, http } from "msw"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../test/msw.js"
import type { KnowledgeDocument } from "../knowledge-store/knowledge-store.js"
import { JevError } from "../retrieval/jev/client.js"
import {
  BudgetSpentError,
  isBudgetSpent,
  type JudgeInput,
  judge,
} from "./orchestrator.js"

describe("the end of the time budget", () => {
  it("is a Jev timeout only when the retrieval has a time budget", () => {
    const timeout = new JevError("timeout", "Jev gave no answer in 30000 ms.")
    expect(isBudgetSpent(timeout, performance.now() + 3_000)).toBe(true)
    // With no time budget (the evals), a Jev timeout is a failed call.
    expect(isBudgetSpent(timeout, Number.POSITIVE_INFINITY)).toBe(false)
    expect(
      isBudgetSpent(new BudgetSpentError("spent"), performance.now()),
    ).toBe(true)
    expect(
      isBudgetSpent(new JevError("http", "busy", 503), performance.now()),
    ).toBe(false)
  })
})

describe("judge", () => {
  const server = useMswServer()
  const calls: string[] = []

  beforeEach(() => {
    calls.length = 0
    vi.stubEnv("MODEL_PROVIDER_URL", "https://jev-gateway.test/api/v1")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    // Each candidate gets a p(answers) from its own text and the texts of
    // the other candidates of its call, as Jev can.
    server.use(
      http.post(
        "https://jev-gateway.test/api/alpha/decisions",
        async ({ request }) => {
          const body = (await request.json()) as {
            state: string[]
            questions: Record<string, unknown>
          }
          calls.push(body.state.join("\n"))
          const texts = body.state.filter((line) =>
            line.startsWith("<data>Doc"),
          )
          const call = texts.join(" ").length
          return HttpResponse.json({
            answers: Object.fromEntries(
              Object.keys(body.questions).map((key) => {
                const n = Number(key.split(".")[1])
                const own = texts[n - 1]?.length ?? 0
                return [
                  key,
                  { type: "noul", noul: ((own * 7 + call) % 100) / 100 },
                ]
              }),
            ),
          })
        },
      ),
    )
  })

  const input = (docKey: string): JudgeInput => {
    const document: KnowledgeDocument = {
      docKey,
      kind: "Issue",
      status: "active",
      deletedAt: null,
      error: "",
      title: `Doc ${docKey}`,
      path: `docs/${docKey}.md`,
      sourceType: "issue",
      source: "",
      summary: "",
      mime: "text/markdown",
      validFrom: null,
      validTo: null,
      observedAt: new Date("2026-11-01T00:00:00Z"),
    }
    return {
      ref: { workspaceId: "ws_a", docKey },
      document,
      text: `Doc ${docKey} ${"x".repeat(docKey.length)}`,
    }
  }

  it("sends the same calls and gives each document the same judgment in any order of the inputs", async () => {
    // 30 inputs: two calls of the default batch. The search order is
    // the order of the inputs.
    const inputs = Array.from({ length: 30 }, (_, index) =>
      input(`kn_${((index * 37) % 101).toString(36).padStart(3, "0")}${index}`),
    )
    const meter = () => ({ jevCalls: 0, jevCandidates: 0, embeddingCalls: 0 })
    const ranked = await judge(inputs, "q", "search", Infinity, meter())
    const rankedCalls = calls.splice(0).sort()
    const reordered = [...inputs.slice(20), ...inputs.slice(0, 20)]
    const other = await judge(reordered, "q", "search", Infinity, meter())

    expect(calls.sort()).toEqual(rankedCalls)
    expect(rankedCalls).toHaveLength(2)
    const byKey = (judged: typeof ranked, order: JudgeInput[]) =>
      new Map(order.map((item, index) => [item.ref.docKey, judged[index]]))
    expect(byKey(other, reordered)).toEqual(byKey(ranked, inputs))
  })
})
