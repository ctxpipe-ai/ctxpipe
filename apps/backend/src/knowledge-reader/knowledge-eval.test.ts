import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  type Dataset,
  datasetSchema,
  readDataset,
} from "../../evals/knowledge/dataset.js"
import {
  ndcgAt,
  percentile,
  positionsCorrect,
  recallAt,
} from "../../evals/knowledge/metrics.js"
import { checkPanel, labelWithPanel } from "../../evals/knowledge/panel.js"
import { parseSettings } from "../../evals/knowledge/runner.js"

/*
 * The parts of the knowledge eval harness that need no store: the dataset
 * checks, the metrics, and the judge panel (msw answers for the models).
 * `knowledge-eval.integration.test.ts` runs the harness end to end.
 */

const datasetFile = new URL(
  "../../evals/knowledge/fixtures/ctxpipe-memory.dataset.json",
  import.meta.url,
).pathname

describe("the dataset", () => {
  it("reads the example questions", async () => {
    const dataset = await readDataset(datasetFile)
    expect(dataset.questions).toHaveLength(12)
    expect(
      new Set(dataset.questions.map((question) => question.category)),
    ).toEqual(
      new Set([
        "lookup",
        "multi-hop",
        "cross-source",
        "time",
        "disagreement",
        "no-answer",
      ]),
    )
  })

  it("refuses gold labels that do not fit the category", async () => {
    const dataset = await readDataset(datasetFile)
    const [question] = dataset.questions
    if (!question) throw new Error("The example has no question.")
    const check = (change: object) =>
      datasetSchema
        .safeParse({
          ...dataset,
          questions: [{ ...question, ...change }],
        })
        .error?.issues.map((issue) => issue.message)
    expect(check({ category: "no-answer" })).toEqual([
      `Question ${question.id}: a no-answer question has no gold document.`,
    ])
    expect(check({ category: "disagreement" })).toEqual([
      `Question ${question.id}: a disagreement question needs seeds for get_related.`,
      `Question ${question.id}: a disagreement question needs at least two positions.`,
    ])
    expect(check({ gold: ["../outside.md"] })?.[0]).toBe(
      "A path is relative, with no empty or `..` segment.",
    )
    expect(check({ corpus: "other" })).toEqual([
      `Question ${question.id} names the unknown corpus other.`,
    ])
  })
})

describe("the metrics", () => {
  const gold = new Set(["a", "b"])

  it("recall@k is the share of gold documents in the first k refs", () => {
    expect(recallAt(["a", "x", "b"], gold, 2)).toBe(0.5)
    expect(recallAt(["a", "x", "b"], gold, 3)).toBe(1)
    expect(recallAt([], new Set(), 5)).toBe(0)
  })

  it("nDCG@k gives a lower score to a gold document at a lower rank", () => {
    expect(ndcgAt(["a", "b"], gold, 10)).toBe(1)
    // DCG 1/log2(3) + 1/log2(4); ideal 1 + 1/log2(3).
    expect(ndcgAt(["x", "a", "b"], gold, 10)).toBeCloseTo(
      (1 / Math.log2(3) + 0.5) / (1 + 1 / Math.log2(3)),
    )
    expect(ndcgAt(["x"], gold, 10)).toBe(0)
  })

  it("positions are correct per expected ref", () => {
    const expected = [
      { refs: ["old"], status: "superseded" as const },
      { refs: ["new"], status: "current" as const },
    ]
    expect(
      positionsCorrect(expected, [{ refs: ["new", "old"], status: "current" }]),
    ).toBe(0.5)
    expect(
      positionsCorrect(expected, [
        { refs: ["old"], status: "superseded" },
        { refs: ["new"], status: "current" },
      ]),
    ).toBe(1)
    expect(positionsCorrect(expected, [])).toBe(0)
  })

  it("percentiles use the nearest rank", () => {
    expect(percentile([30, 10, 20, 40], 50)).toBe(20)
    expect(percentile([30, 10, 20, 40], 95)).toBe(40)
    expect(percentile([], 50)).toBeNull()
  })

  it("a run changes only known numeric settings of the loop", () => {
    expect(parseSettings(["keepAt=0.6"])).toEqual({ keepAt: 0.6 })
    expect(() => parseSettings(["toString=1"])).toThrow(/Unknown setting/)
    expect(() => parseSettings(["keepAt=high"])).toThrow(/needs a number/)
  })
})

describe("the judge panel", () => {
  const BASE = "https://panel.test/v1"
  /** model → ref → [answers, status]. */
  const replies: Record<string, Record<string, [boolean, string]>> = {
    "anthropic/judge-a": {
      "old.md": [true, "superseded"],
      "new.md": [true, "current"],
      "noise.md": [true, "none"],
      "lonely.md": [false, "none"],
    },
    "openai/judge-b": {
      "old.md": [true, "superseded"],
      "new.md": [true, "scoped"],
      "noise.md": [false, "none"],
      "lonely.md": [false, "none"],
    },
    "google/judge-c": {
      "old.md": [true, "current"],
      "new.md": [true, "current"],
      "noise.md": [false, "none"],
      "lonely.md": [true, "none"],
    },
  }
  const asked: string[] = []
  const server = setupServer(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as {
        model: string
        messages: { content: string }[]
      }
      const ref = /Document <data>(.*?)<\/data>/.exec(
        body.messages[0]?.content ?? "",
      )?.[1]
      asked.push(body.model)
      const [answers, status] = replies[body.model]?.[ref ?? ""] ?? [
        false,
        "none",
      ]
      return HttpResponse.json({
        choices: [
          { message: { content: JSON.stringify({ answers, status }) } },
        ],
      })
    }),
  )
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
  afterAll(() => server.close())

  const draft: Dataset = {
    version: "draft",
    corpora: [
      {
        id: "corpus",
        source: "example/source",
        contextRepo: {
          url: "https://example.test/repo",
          sha: "e".repeat(40),
        },
        workspace: "corpus-v0",
      },
    ],
    questions: [
      {
        id: "which-current",
        corpus: "corpus",
        category: "disagreement",
        split: "dev",
        text: "Which rule is current?",
        gold: ["old.md", "new.md", "noise.md"],
        seeds: ["new.md"],
        positions: [
          { refs: ["old.md"], status: "superseded" },
          { refs: ["new.md"], status: "scoped" },
        ],
        keyFacts: ["The new rule is current."],
      },
      {
        id: "lonely",
        corpus: "corpus",
        category: "lookup",
        split: "holdout",
        text: "What does the lonely file say?",
        gold: ["lonely.md"],
        keyFacts: ["It says nothing useful."],
      },
    ],
  }

  it("keeps the gold documents and the statuses that most models give", async () => {
    const labeled = await labelWithPanel({
      draft,
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      env: { MODEL_PROVIDER_API_KEY: "fixture-only", MODEL_PROVIDER_URL: BASE },
    })
    // 4 documents, 3 models each.
    expect(asked).toHaveLength(12)
    expect(labeled.dataset.questions).toEqual([
      {
        ...draft.questions[0],
        // One model of three says that noise.md answers: not gold.
        gold: ["old.md", "new.md"],
        // Two models say current: the draft status `scoped` changes.
        positions: [
          { refs: ["old.md"], status: "superseded" },
          { refs: ["new.md"], status: "current" },
        ],
      },
    ])
    // No gold document is left, so the question is out.
    expect(labeled.dropped).toEqual(["lonely"])
    expect(
      labeled.votes.find((vote) => vote.ref === "noise.md")?.votes,
    ).toHaveLength(3)
  })

  it("needs an odd number of model families, and never Jev", () => {
    expect(() => checkPanel(["anthropic/a", "openai/b"])).toThrow(/odd number/)
    expect(() =>
      checkPanel(["anthropic/a", "anthropic/b", "openai/c"]),
    ).toThrow(/different family/)
    expect(() =>
      checkPanel(["anthropic/a", "openai/b", "typesafe/jev-1.14"]),
    ).toThrow(/never a judge/)
  })
})
