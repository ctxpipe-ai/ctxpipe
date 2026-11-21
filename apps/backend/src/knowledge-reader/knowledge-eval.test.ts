import { delay, HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"

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
import { ModelCalls } from "../../evals/knowledge/model-calls.js"
import { checkPanel, labelWithPanel } from "../../evals/knowledge/panel.js"
import { buildReport, renderMarkdown } from "../../evals/knowledge/report.js"
import { parseSettings } from "../../evals/knowledge/runner.js"
import { madeUpPrivateKey } from "../../test/made-up-key.js"
import { useMswServer } from "../../test/msw.js"
import { ORCHESTRATOR_DEFAULTS } from "./orchestrator.js"

/*
 * The parts of the knowledge eval harness that need no store: the dataset
 * checks, the metrics, the spend cap and the judge panel (msw answers for
 * the models).
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
    expect(() => parseSettings(["keepAt=0.6", "exploreAt=0.4"])).toThrow(
      /one setting/,
    )
    expect(() => parseSettings(["keepAt=high"])).toThrow(/needs a number/)
  })
})

describe("the spend cap", () => {
  const BASE = "https://cap.test/v1"
  const JEV = "https://cap.test/alpha/decisions"
  let sent = 0
  useMswServer(
    // A Jev answer costs $0.0015, below its reservation of $0.002.
    http.post(JEV, async () => {
      sent += 1
      await delay(20)
      return HttpResponse.json({ answers: {}, usage: { cost: 0.0015 } })
    }),
    // An embedding answer with no cost; a slow one when the body says so.
    http.post(`${BASE}/embeddings`, async ({ request }) => {
      sent += 1
      if (((await request.json()) as { slow?: boolean }).slow) await delay(50)
      return HttpResponse.json({ data: [] })
    }),
  )
  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", body: JSON.stringify(body) })

  it("never lets calls in parallel take the run over the cap", async () => {
    sent = 0
    const calls = new ModelCalls(BASE, 0.005)
    const restore = calls.install()
    try {
      const answers = await Promise.all(
        Array.from({ length: 10 }, (_, index) => post(JEV, { index })),
      )
      // Each call reserves $0.002: two fit in $0.005, a third would not.
      expect(sent).toBe(2)
      expect(answers.filter((answer) => answer.status === 503)).toHaveLength(8)
      expect(calls.stopped).toBe(true)
      // The real cost replaced the reservations.
      expect(calls.spentUsd).toBeCloseTo(0.003)
      // $0.003 + $0.002 fits, but a stopped run sends nothing more.
      expect((await post(JEV, { index: 10 })).status).toBe(503)
      expect(sent).toBe(2)
      expect(calls.spentUsd).toBeLessThanOrEqual(0.005)
    } finally {
      restore()
    }
  })

  it("gives a slow call to the question that sent it, and waits for it", async () => {
    const calls = new ModelCalls(BASE, 1)
    const restore = calls.install()
    try {
      calls.begin("plane", "first")
      // The reader stops waiting at its time budget; the call goes on.
      void post(`${BASE}/embeddings`, { slow: true })
      await calls.settle()
      expect(calls.end()).toMatchObject({ embedding: 1, costUsd: 0.001 })
      calls.begin("plane", "second")
      void post(`${BASE}/embeddings`, { slow: true })
      calls.begin("plane", "third")
      await calls.settle()
      expect(calls.end()).toMatchObject({ embedding: 0, costUsd: 0 })
      expect(calls.records.map((call) => call.question)).toEqual([
        "first",
        "second",
      ])
    } finally {
      restore()
    }
  })

  it("counts the questions of each Jev call, live and in a replay", async () => {
    const live = new ModelCalls(BASE, 1)
    let restore = live.install()
    try {
      live.begin("plane", "question")
      await post(JEV, { questions: { "same.1.2": {}, "scoped.1": {} } })
      await post(JEV, { questions: { "answers.1": {} } })
      expect(live.end()).toMatchObject({ jev: 2, jevQuestions: 3 })
    } finally {
      restore()
    }
    const replay = new ModelCalls(BASE, 0, live.records)
    restore = replay.install()
    try {
      replay.begin("plane", "question")
      await post(JEV, { questions: { "same.1.2": {}, "scoped.1": {} } })
      expect(replay.end()).toMatchObject({
        jev: 1,
        jevQuestions: 2,
        missing: 0,
      })
    } finally {
      restore()
    }
  })

  it("reserves an embedding batch by the size of its input", async () => {
    sent = 0
    const calls = new ModelCalls(BASE, 0.005)
    const restore = calls.install()
    try {
      // 64 chunks of 200 bytes: $0.0064 at $0.5 for each million bytes,
      // above the cap.
      const batch = Array.from({ length: 64 }, () => "x".repeat(200))
      expect((await post(`${BASE}/embeddings`, { input: batch })).status).toBe(
        503,
      )
      expect(sent).toBe(0)
      expect(calls.stopped).toBe(true)
    } finally {
      restore()
    }
  })

  it("counts an answer with no cost at the reserved value", async () => {
    sent = 0
    const calls = new ModelCalls(BASE, 1)
    const restore = calls.install()
    try {
      calls.begin("plane", "question")
      expect((await post(`${BASE}/embeddings`, { input: ["q"] })).ok).toBe(true)
      expect(calls.spentUsd).toBe(0.001)
      expect(calls.records).toMatchObject([
        { kind: "embedding", costUsd: 0.001, estimated: true },
      ])
      expect(calls.end()).toEqual({
        jev: 0,
        jevQuestions: 0,
        embedding: 1,
        costUsd: 0.001,
        missing: 0,
      })
    } finally {
      restore()
    }
  })
})

describe("the comparison with the kept run", () => {
  it("counts an error of this run, not of the kept run, in the guards", async () => {
    const dataset = await readDataset(datasetFile)
    const id = "orm-dist-tag"
    const calls = { jev: 1, jevQuestions: 2, embedding: 1, costUsd: 0.001 }
    const report = buildReport({
      manifest: {
        datasetVersion: dataset.version,
        splits: ["dev"],
        now: "2026-11-20T00:00:00.000Z",
        settings: {},
        loop: { ...ORCHESTRATOR_DEFAULTS },
        mode: "live",
        capUsd: 1,
        spentUsd: 0.002,
        stopped: false,
      },
      dataset: {
        ...dataset,
        questions: dataset.questions.filter((question) => question.id === id),
      },
      answers: [
        {
          arm: "legacy",
          question: id,
          search: { refs: [], scores: [], latencyMs: 10 },
          calls: { ...calls, missing: 0 },
        },
        {
          arm: "plane",
          question: id,
          search: { error: "internal", latencyMs: 10 },
          calls: { ...calls, missing: 0 },
        },
      ],
      kept: {
        run: { mode: "live" },
        questions: [
          {
            arm: "plane",
            question: id,
            metrics: {
              recall5: 1,
              ndcg10: 1,
              searchRecall50: 1,
              traversalRecall: null,
              noAnswer: null,
              positions: null,
            },
            searchMs: 10,
            relatedMs: null,
            jevCalls: 1,
            jevQuestions: 2,
            costUsd: 0.001,
          },
        ],
      },
    })
    expect(
      report.kept?.guards.map(({ kept, now }) => ({
        kept: kept.errors,
        now: now.errors,
      })),
    ).toEqual([{ kept: 0, now: 1 }])
    expect(renderMarkdown(report)).toContain(
      "| dev | 1 | errors | 0 | 1 | +1 |",
    )
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
      "split-a.md": [true, "current"],
      "split-b.md": [true, "current"],
    },
    "openai/judge-b": {
      "old.md": [true, "superseded"],
      "new.md": [true, "scoped"],
      "noise.md": [false, "none"],
      "lonely.md": [false, "none"],
      "split-a.md": [true, "current"],
      "split-b.md": [true, "superseded"],
    },
    "google/judge-c": {
      "old.md": [true, "current"],
      "new.md": [true, "current"],
      "noise.md": [false, "none"],
      "lonely.md": [true, "none"],
      "split-a.md": [true, "current"],
      "split-b.md": [true, "scoped"],
    },
  }
  const asked: string[] = []
  const providers: unknown[] = []
  const contents: string[] = []
  /** From this call on, the endpoint answers 503, as the spend cap does. */
  let capAt = Number.POSITIVE_INFINITY
  useMswServer(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      if (asked.length >= capAt)
        return HttpResponse.json({ error: "capped" }, { status: 503 })
      const body = (await request.json()) as {
        model: string
        messages: { content: string }[]
        provider: unknown
      }
      providers.push(body.provider)
      contents.push(body.messages[0]?.content ?? "")
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

  const draft: Dataset = {
    version: "draft",
    corpora: [
      {
        id: "corpus",
        source: "example/source",
        contextRepo: {
          url: "https://example.test/repo",
          sha: "e".repeat(40),
          root: "",
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
      {
        id: "split-vote",
        corpus: "corpus",
        category: "disagreement",
        split: "dev",
        text: "Which plan holds?",
        gold: ["split-a.md", "split-b.md"],
        seeds: ["split-a.md"],
        positions: [
          { refs: ["split-a.md"], status: "current" },
          { refs: ["split-b.md"], status: "superseded" },
        ],
        keyFacts: ["Plan A holds."],
      },
    ],
  }
  const env = {
    MODEL_PROVIDER_API_KEY: "fixture-only",
    MODEL_PROVIDER_URL: BASE,
  }

  it("scrubs each document before the prompt cuts it: a private key across the cut goes to no judge", async () => {
    const key = madeUpPrivateKey(4096)
    contents.length = 0
    await labelWithPanel({
      draft: { ...draft, questions: draft.questions.slice(1, 2) },
      models: Object.keys(replies),
      // The cut (12,000 characters) falls inside the key.
      read: async () => `${"x".repeat(10_000)}\n${key}\n`,
      env,
      stopped: () => false,
    })
    expect(contents).toHaveLength(3)
    for (const content of contents)
      for (const line of key.split("\n").slice(1, -1))
        expect(content).not.toContain(line)
  })

  it("keeps the gold documents and the statuses that most models give", async () => {
    asked.length = 0
    const labeled = await labelWithPanel({
      draft,
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      env,
      stopped: () => false,
    })
    // 6 documents, 3 models each.
    expect(asked).toHaveLength(18)
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
    expect(labeled.dropped).toEqual([
      // No gold document is left.
      {
        question: "lonely",
        reason: "the question needs at least one gold document",
      },
      // Each model gives split-b.md another status: a person decides.
      {
        question: "split-vote",
        reason:
          "no majority status for split-b.md; a disagreement question needs at least two positions",
      },
    ])
    expect(labeled.stopped).toBe(false)
    expect(
      labeled.votes.find((vote) => vote.ref === "noise.md")?.votes,
    ).toHaveLength(3)
  })

  it("sends each judge call with the provider block of ADR-070", async () => {
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "openai,anthropic")
    providers.length = 0
    try {
      await labelWithPanel({
        draft: { ...draft, questions: draft.questions.slice(1, 2) },
        models: Object.keys(replies),
        read: async (_corpus, ref) => `The text of ${ref}.`,
        env,
        stopped: () => false,
      })
    } finally {
      vi.unstubAllEnvs()
    }
    expect(providers).toHaveLength(3)
    for (const provider of providers)
      expect(provider).toEqual({
        data_collection: "deny",
        zdr: true,
        only: ["openai", "anthropic"],
      })
  })

  it("stops at the spend cap and keeps the votes before the stop", async () => {
    asked.length = 0
    capAt = 4
    try {
      const labeled = await labelWithPanel({
        draft,
        models: Object.keys(replies),
        read: async (_corpus, ref) => `The text of ${ref}.`,
        env,
        stopped: () => asked.length >= capAt,
      })
      expect(labeled.stopped).toBe(true)
      // The first document got its 3 votes; the stop came in the second.
      expect(labeled.votes.map((vote) => vote.ref)).toEqual(["old.md"])
      expect(labeled.dataset.questions).toEqual([])
    } finally {
      capAt = Number.POSITIVE_INFINITY
    }
  })

  it("sends nothing when the model provider is not OpenRouter", async () => {
    asked.length = 0
    await expect(
      labelWithPanel({
        draft,
        models: Object.keys(replies),
        read: async (_corpus, ref) => `The text of ${ref}.`,
        env: { ...env, MODEL_PROVIDER: "bedrock" },
        stopped: () => false,
      }),
    ).rejects.toThrow(/MODEL_PROVIDER openrouter or openai-like/)
    expect(asked).toEqual([])
  })

  it("needs three model families, and never Jev", () => {
    expect(() => checkPanel(["anthropic/a", "openai/b"])).toThrow(
      /three models/,
    )
    expect(() =>
      checkPanel(["anthropic/a", "anthropic/b", "openai/c"]),
    ).toThrow(/different family/)
    expect(() =>
      checkPanel(["anthropic/a", "openai/b", "typesafe/jev-1.14"]),
    ).toThrow(/never a judge/)
  })
})
