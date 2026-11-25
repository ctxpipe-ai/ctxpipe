import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { delay, HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"

import { main } from "../../evals/knowledge/cli.js"
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
import {
  ModelCalls,
  type RecordedCall,
  recordedCallSchema,
} from "../../evals/knowledge/model-calls.js"
import { checkPanel, labelWithPanel } from "../../evals/knowledge/panel.js"
import {
  buildReport,
  keptRunSchema,
  renderMarkdown,
} from "../../evals/knowledge/report.js"
import { parseSettings } from "../../evals/knowledge/runner.js"
import { madeUpPrivateKey } from "../../test/made-up-key.js"
import { useMswServer } from "../../test/msw.js"
import { decideNoul, JEV_MODEL } from "../retrieval/jev/client.js"
import { askDisagreementFacts } from "../retrieval/jev/disagreement.js"
import { judgeLayer } from "../retrieval/jev/layer-judge.js"
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
  it.each([
    {
      file: "corpora-v0.dataset.json",
      version: "0",
      corpora: ["kubernetes", "rust"],
      least: 40,
    },
    {
      file: "backstage-v0.dataset.json",
      version: "backstage-0",
      corpora: ["backstage"],
      least: 35,
    },
  ])("reads the question set $file, by the rules of v0", async (expected) => {
    const dataset = await readDataset(
      new URL(
        `../../evals/knowledge/fixtures/${expected.file}`,
        import.meta.url,
      ).pathname,
    )
    expect(dataset.version).toBe(expected.version)
    expect(dataset.corpora.map((corpus) => corpus.id)).toEqual(expected.corpora)
    for (const corpus of dataset.corpora) {
      const questions = dataset.questions.filter(
        (question) => question.corpus === corpus.id,
      )
      expect(questions.length).toBeGreaterThanOrEqual(expected.least)
      // No image in the corpora, and no validAt in v0.
      expect(questions.some((question) => question.category === "image")).toBe(
        false,
      )
      expect(questions.some((question) => question.validAt)).toBe(false)
      // In each category, the count of holdout questions is the nearest
      // whole number to 40%.
      for (const category of new Set(
        questions.map((question) => question.category),
      )) {
        const inCategory = questions.filter(
          (question) => question.category === category,
        )
        expect(
          inCategory.filter((question) => question.split === "holdout").length,
        ).toBe(Math.round(0.4 * inCategory.length))
      }
    }
  })

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
    // Positions that do not disagree.
    const disagreement = (positions: object[]) =>
      check({
        category: "disagreement",
        gold: ["a.md", "b.md"],
        seeds: ["a.md"],
        positions,
      })
    expect(
      disagreement([
        { refs: ["a.md"], status: "current" },
        { refs: ["a.md"], status: "current" },
      ]),
    ).toEqual([
      `Question ${question.id}: a document is in more than one position.`,
      `Question ${question.id}: a disagreement question needs at least two documents in its positions.`,
      `Question ${question.id}: a disagreement question needs a position that is not current.`,
    ])
    expect(
      disagreement([
        { refs: ["a.md"], status: "current" },
        { refs: ["b.md"], status: "current" },
      ]),
    ).toEqual([
      `Question ${question.id}: a disagreement question needs a position that is not current.`,
    ])
    expect(
      disagreement([
        { refs: ["a.md"], status: "superseded" },
        { refs: ["b.md"], status: "current" },
      ]),
    ).toBeUndefined()
    // Two disputed documents disagree, also with one status.
    expect(
      disagreement([
        { refs: ["a.md"], status: "disputed" },
        { refs: ["b.md"], status: "disputed" },
      ]),
    ).toBeUndefined()
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

describe('the retrieval metrics of a "no answer"', () => {
  // A client that reads "no answer" does not use the hits (CTX-1562). The
  // scores are below 0.5 or above 0.6, so the test holds for each "no
  // answer" threshold of the report.
  const metricsOf = async (
    id: string,
    arm: "legacy" | "plane",
    search: { scores: number[]; partialReason?: string },
  ) => {
    const dataset = await readDataset(datasetFile)
    const question = dataset.questions.find((item) => item.id === id)
    if (!question) throw new Error(`The example has no question ${id}.`)
    const refs = [...question.gold, "other.md"].slice(0, search.scores.length)
    const answer = (answerArm: "legacy" | "plane") => ({
      arm: answerArm,
      question: id,
      search: { refs, latencyMs: 10, ...search },
      calls: {
        jev: 1,
        jevQuestions: 1,
        embedding: 1,
        costUsd: 0,
        missing: 0,
        failed: 0,
        unrecorded: 0,
      },
    })
    const report = buildReport({
      manifest: {
        datasetVersion: dataset.version,
        splits: ["dev"],
        now: "2026-11-24T00:00:00.000Z",
        settings: {},
        loop: { keepAt: 0.5 },
        mode: "live",
        capUsd: 1,
        spentUsd: 0,
        stopped: false,
      },
      dataset: { ...dataset, questions: [question] },
      // A report scores a question only with an answer of each arm.
      answers: [answer("legacy"), answer("plane")],
      kept: null,
    })
    return report.questions.find((score) => score.arm === arm)?.metrics
  }
  const retrieval = (metrics: Awaited<ReturnType<typeof metricsOf>>) => ({
    recall5: metrics?.recall5,
    ndcg10: metrics?.ndcg10,
    searchRecall50: metrics?.searchRecall50,
    noAnswer: metrics?.noAnswer,
  })

  it("scores a plane search with no hit at the threshold as an empty result", async () => {
    const answered = { recall5: 1, ndcg10: 1, searchRecall50: 1 }
    const empty = { recall5: 0, ndcg10: 0, searchRecall50: 0 }
    // An answerable question: a false "no answer" costs all its recall.
    expect(
      retrieval(await metricsOf("orm-dist-tag", "plane", { scores: [0.4] })),
    ).toEqual({ ...empty, noAnswer: null })
    expect(
      retrieval(await metricsOf("orm-dist-tag", "plane", { scores: [0.7] })),
    ).toEqual({ ...answered, noAnswer: null })
    // The old stack has no threshold: it says "no answer" only with no hit.
    expect(
      retrieval(await metricsOf("orm-dist-tag", "legacy", { scores: [0.4] })),
    ).toEqual({ ...answered, noAnswer: null })
    // A partial search does not say "no answer", so its hits keep their score.
    expect(
      retrieval(
        await metricsOf("orm-dist-tag", "plane", {
          scores: [0.4],
          partialReason: "time_budget",
        }),
      ),
    ).toEqual({ ...answered, noAnswer: null })
    // A correct "no answer" does not change.
    expect(
      retrieval(
        await metricsOf("billing-provider", "plane", { scores: [0.4] }),
      ),
    ).toEqual({
      recall5: null,
      ndcg10: null,
      searchRecall50: null,
      noAnswer: 1,
    })
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
        failed: 0,
        unrecorded: 0,
      })
    } finally {
      restore()
    }
  })
})

describe("the replay key", () => {
  const BASE = "https://openrouter.ai/api/v1"
  const JEV = "https://openrouter.ai/api/alpha/decisions"
  useMswServer(
    http.post(JEV, () => HttpResponse.json({ error: "live" }, { status: 500 })),
    http.post(`${BASE}/embeddings`, () =>
      HttpResponse.json({ error: "live" }, { status: 500 }),
    ),
  )
  afterEach(() => vi.unstubAllEnvs())

  /** A line of `calls.jsonl` of the harness of before CTX-1450. */
  const keptCall = (
    kind: "jev" | "embedding",
    request: object,
    response: object,
  ) =>
    recordedCallSchema.parse({
      arm: "plane",
      question: "question",
      kind,
      // The old replay key: the hash of the request body. A replay of now
      // does not read it.
      key: "0".repeat(64),
      request,
      status: 200,
      response: JSON.stringify(response),
      costUsd: 0.001,
      estimated: false,
      latencyMs: 10,
    })

  it("replays a call that was kept before CTX-1450 added provider.only", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_URL", BASE)
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "openai,azure")
    const state = ["The sky is blue."]
    const questions = {
      sky: { type: "noul" as const, instructions: "Is the sky blue?" },
    }
    // The Jev client of before CTX-1450 sent the ZDR block with no `only`.
    const jevBody = {
      model: JEV_MODEL,
      state,
      questions,
      provider: { data_collection: "deny", zdr: true },
    }
    // The old stack sent no provider block; the old recorder added the ZDR
    // block to the request that it kept.
    const embeddingBody = { model: "made-up/embedding", input: ["sky"] }
    const replay = new ModelCalls(BASE, 0, [
      keptCall("jev", jevBody, {
        answers: { sky: { type: "noul", noul: 0.9 } },
      }),
      keptCall(
        "embedding",
        {
          ...embeddingBody,
          provider: { data_collection: "deny", zdr: true },
        },
        { data: [{ embedding: [1, 0] }] },
      ),
    ])
    const restore = replay.install()
    try {
      replay.begin("plane", "question")
      // The real client sends the block of now, with `only`.
      const answers = await decideNoul(state, questions, {
        timeoutMs: 5_000,
        attributes: {},
      })
      expect(answers.get("sky")).toBe(0.9)
      const embedding = await fetch(`${BASE}/embeddings`, {
        method: "POST",
        body: JSON.stringify({
          ...embeddingBody,
          provider: { data_collection: "deny", zdr: true, only: ["azure"] },
        }),
      })
      expect(await embedding.json()).toEqual({ data: [{ embedding: [1, 0] }] })
      expect(replay.end()).toMatchObject({ jev: 1, embedding: 1, missing: 0 })
    } finally {
      restore()
    }
  })

  it("counts a failed call, but not a call that the reader stopped at its time budget", async () => {
    const calls = new ModelCalls(BASE, 1)
    const restore = calls.install()
    try {
      calls.begin("plane", "question")
      const body = JSON.stringify({ input: ["sky"] })
      expect(
        (await fetch(`${BASE}/embeddings`, { method: "POST", body })).status,
      ).toBe(500)
      await expect(
        fetch(`${BASE}/embeddings`, {
          method: "POST",
          body,
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow()
      expect(calls.end()).toMatchObject({ embedding: 1, failed: 1 })
    } finally {
      restore()
    }
  })

  it("still misses a call whose answer fields changed", async () => {
    const body = { model: "made-up/embedding", input: ["sky"] }
    const replay = new ModelCalls(BASE, 0, [
      keptCall("embedding", body, { data: [] }),
    ])
    const restore = replay.install()
    try {
      replay.begin("plane", "question")
      const response = await fetch(`${BASE}/embeddings`, {
        method: "POST",
        body: JSON.stringify({ ...body, input: ["sea"] }),
      })
      expect(response.status).toBe(503)
      expect(replay.end()).toMatchObject({ embedding: 0, missing: 1 })
    } finally {
      restore()
    }
  })
})

describe("the replay of a Jev question in another call", () => {
  const BASE = "https://openrouter.ai/api/v1"
  const JEV = "https://openrouter.ai/api/alpha/decisions"
  const server = useMswServer()
  afterEach(() => vi.unstubAllEnvs())

  const meta = {
    status: "active",
    sourceType: "docs",
    observedAt: "2026-11-01T00:00:00.000Z",
    validFrom: null,
    validTo: null,
    confidence: null,
  }
  const judgeWhy = (ids: string[]) =>
    judgeLayer({
      question: "q",
      intent: "why",
      candidates: ids.map((id) => ({ id, text: `The text of ${id}.`, meta })),
    })
  const item = (id: string) => ({
    id,
    passage: `The passage of ${id}.`,
    meta: { ...meta, documentKey: id },
  })

  /** Record the calls of `ask` with a Jev that answers from `record`. */
  async function recorded(
    record: Record<string, number>,
    ask: () => Promise<unknown>,
  ) {
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_URL", BASE)
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    server.use(
      http.post(JEV, async ({ request }) => {
        const { questions } = (await request.json()) as {
          questions: Record<string, unknown>
        }
        return HttpResponse.json({
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { type: "noul", noul: record[key] },
            ]),
          ),
        })
      }),
    )
    const live = new ModelCalls(BASE, 1)
    const restore = live.install()
    try {
      live.begin("plane", "question")
      await ask()
    } finally {
      restore()
    }
    // A replay sends nothing.
    server.use(
      http.post(JEV, () =>
        HttpResponse.json({ error: "live" }, { status: 500 }),
      ),
    )
    return live.records
  }

  /** Run `step` on a replay of `records`, then give its counts. */
  async function replayed(
    records: readonly RecordedCall[],
    step: () => Promise<unknown>,
    options?: { unrecordedYes?: number },
  ) {
    const replay = new ModelCalls(BASE, 0, records, options)
    const restore = replay.install()
    try {
      replay.begin("plane", "question")
      const result = await step().catch((error: unknown) => error)
      return { result, counts: replay.end(), records: replay.records }
    } finally {
      restore()
    }
  }

  it("answers a question from a recorded call that asked it about the same item, and keeps that call", async () => {
    const calls = await recorded(
      {
        "answers.1": 0.9,
        "explore.1": 0.2,
        "answers.2": 0.3,
        "explore.2": 0.8,
      },
      () => judgeWhy(["a", "b"]),
    )
    // b and a in their own calls, under other numbers.
    const first = await replayed(calls, () =>
      Promise.all([judgeWhy(["b"]), judgeWhy(["a"])]),
    )
    const [b, a] = first.result as Map<string, unknown>[]
    expect(b?.get("b")).toEqual({ pAnswers: 0.3, pExplore: 0.8 })
    expect(a?.get("a")).toEqual({ pAnswers: 0.9, pExplore: 0.2 })
    expect(first.counts).toMatchObject({ jev: 2, missing: 0, unrecorded: 0 })
    // A run with a live fallback (`--reuse-from`) sends the changed
    // request, so that the run measures it. The mock refuses each live call.
    const reuse = new ModelCalls(BASE, 1, calls, { liveFallback: true })
    const restoreReuse = reuse.install()
    try {
      reuse.begin("plane", "question")
      await expect(judgeWhy(["b"])).rejects.toThrow()
      expect(reuse.reuseSummary()).toEqual({ reused: 0, live: 1 })
    } finally {
      restoreReuse()
    }
    // The replay keeps the recorded call, so a replay of it answers again.
    const second = await replayed(first.records, () => judgeWhy(["b"]))
    expect((second.result as Map<string, unknown>).get("b")).toEqual({
      pAnswers: 0.3,
      pExplore: 0.8,
    })
  })

  it("misses a call with an unrecorded question; --unrecorded-yes fills only a disagreement fact", async () => {
    const calls = await recorded(
      { "answers.1": 0.9, "explore.1": 0.2, "scoped.1": 0.4 },
      async () => {
        await judgeWhy(["a"])
        await askDisagreementFacts({ question: "q", items: [item("a")] })
      },
    )
    // c is new: a deeper walk, for example, stays incomplete, also with
    // the fill.
    for (const options of [undefined, { unrecordedYes: 1 }]) {
      const missed = await replayed(calls, () => judgeWhy(["c", "a"]), options)
      expect(missed.result).toBeInstanceOf(Error)
      expect(missed.counts).toMatchObject({ jev: 0, missing: 1 })
    }
    // The facts of the pair (a, c) and of c are new: they miss, unless the
    // fill gives them its p(yes).
    const facts = () =>
      askDisagreementFacts({ question: "q", items: [item("a"), item("c")] })
    expect((await replayed(calls, facts)).result).toBeInstanceOf(Error)
    const filled = await replayed(calls, facts, { unrecordedYes: 1 })
    expect(
      Object.fromEntries(
        (filled.result as { answers: Map<string, number> }).answers,
      ),
    ).toEqual({
      "same.1.2": 1,
      "disagree.1.2": 1,
      "replaces.1.2": 1,
      "replaces.2.1": 1,
      "scoped.1": 0.4,
      "scoped.2": 1,
    })
    expect(filled.counts).toMatchObject({ jev: 1, missing: 0, unrecorded: 5 })
    // The estimated cost: the text of the call at the cost for each
    // character of the recorded call that it used.
    expect(filled.counts.costUsd).toBeGreaterThan(0)
  })

  it("reads a symmetric pair fact in either order of the items, and a directed one only in its own direction", async () => {
    // a is Item 1 and b is Item 2. b replaces a.
    const calls = await recorded(
      {
        "same.1.2": 0.9,
        "disagree.1.2": 0.8,
        "replaces.1.2": 0.1,
        "replaces.2.1": 0.7,
        "scoped.1": 0.2,
        "scoped.2": 0.3,
      },
      () =>
        askDisagreementFacts({ question: "q", items: [item("a"), item("b")] }),
    )
    // b is Item 1 and a is Item 2 now.
    const { result, counts } = await replayed(calls, () =>
      askDisagreementFacts({ question: "q", items: [item("b"), item("a")] }),
    )
    expect(
      Object.fromEntries((result as { answers: Map<string, number> }).answers),
    ).toEqual({
      "same.1.2": 0.9,
      "disagree.1.2": 0.8,
      "replaces.1.2": 0.7,
      "replaces.2.1": 0.1,
      "scoped.1": 0.3,
      "scoped.2": 0.2,
    })
    expect(counts).toMatchObject({ jev: 1, unrecorded: 0 })
  })
})

describe("a run with a failed call", () => {
  it("is not complete: the report counts the failed answers", async () => {
    const dataset = await readDataset(datasetFile)
    const [first, second, third] = dataset.questions
    if (!first || !second || !third)
      throw new Error("The example has few questions.")
    const calls = { jev: 1, jevQuestions: 1, embedding: 1, costUsd: 0.001 }
    const answer = (
      arm: "legacy" | "plane",
      question: string,
      failed: boolean,
      missing = 0,
    ) => ({
      arm,
      question,
      search: failed
        ? { error: "Error", latencyMs: 10 }
        : { refs: [], scores: [], latencyMs: 10 },
      calls: { ...calls, missing, failed: 0, unrecorded: 0 },
    })
    const report = buildReport({
      manifest: {
        datasetVersion: dataset.version,
        splits: ["dev", "holdout"],
        now: "2026-11-20T00:00:00.000Z",
        settings: {},
        loop: { ...ORCHESTRATOR_DEFAULTS },
        mode: "replay",
        capUsd: 0,
        spentUsd: 0,
        stopped: false,
      },
      dataset: { ...dataset, questions: [first, second, third] },
      answers: [
        answer("legacy", first.id, false),
        answer("plane", first.id, true),
        // A failed query embedding gives a partial answer with no hits, and
        // a failed Jev call gives `judge_unavailable`: both are errors.
        {
          ...answer("legacy", third.id, false),
          calls: { ...calls, missing: 0, failed: 1, unrecorded: 0 },
        },
        {
          ...answer("plane", third.id, false),
          search: {
            refs: [],
            scores: [],
            partialReason: "judge_unavailable",
            latencyMs: 10,
          },
        },
        // A replay that misses a call is incomplete, not an error.
        answer("legacy", second.id, false),
        answer("plane", second.id, true, 1),
      ],
      kept: null,
    })
    expect(report).toMatchObject({
      status: "errors",
      errors: 3,
      incomplete: [second.id],
    })
    const markdown = renderMarkdown(report)
    expect(markdown).toContain("Status: errors.")
    expect(markdown).toContain("**3 answers have a failed call")
    expect(markdown).toContain(`- ${third.id} (legacy): 1 failed model calls`)
    expect(markdown).toContain(
      `- ${third.id} (plane): search: judge_unavailable`,
    )
  })
})

describe("the product time budget", () => {
  it("counts and lists each answer of a live run that is over the budget of the product", async () => {
    const dataset = await readDataset(datasetFile)
    const [first, second] = dataset.questions.filter(
      (question) => question.seeds,
    )
    if (!first || !second) throw new Error("The example has few seeds.")
    const calls = { jev: 1, jevQuestions: 1, embedding: 1, costUsd: 0 }
    const answer = (
      arm: "legacy" | "plane",
      question: string,
      relatedMs: number,
    ) => ({
      arm,
      question,
      search: { refs: [], scores: [], latencyMs: 900 },
      related: { refs: [], scores: [], latencyMs: relatedMs },
      calls: { ...calls, missing: 0, failed: 0, unrecorded: 0 },
    })
    const input = {
      manifest: {
        datasetVersion: dataset.version,
        splits: ["dev" as const],
        now: "2026-11-22T00:00:00.000Z",
        settings: {},
        loop: { ...ORCHESTRATOR_DEFAULTS, timeBudgetMs: 0 },
        productBudgetMs: 3_000,
        mode: "live" as const,
        capUsd: 1,
        spentUsd: 0,
        stopped: false,
      },
      dataset: { ...dataset, questions: [first, second] },
      answers: [
        answer("legacy", first.id, 800),
        answer("plane", first.id, 4_250),
        answer("legacy", second.id, 800),
        answer("plane", second.id, 2_900),
      ],
    }
    const report = buildReport({ ...input, kept: null })
    expect(
      report.operations.map(({ arm, overProductBudget }) => ({
        arm,
        overProductBudget,
      })),
    ).toEqual([
      { arm: "legacy", overProductBudget: null },
      { arm: "plane", overProductBudget: 1 },
    ])
    const markdown = renderMarkdown(report)
    expect(markdown).toContain("## Answers over the product time budget")
    expect(markdown).toContain(`- ${first.id} (plane): get_related 4250 ms`)
    expect(markdown).not.toContain(`- ${second.id} (plane)`)
    // A kept run with the budget of the product: the report says that the
    // comparison also holds the change of the budget.
    const kept = keptRunSchema.parse({
      ...report,
      run: { ...report.run, loop: { ...report.run.loop, timeBudgetMs: 3_000 } },
    })
    expect(renderMarkdown(buildReport({ ...input, kept }))).toContain(
      "**The kept run had a time budget of 3000 ms, and this run has no time budget.**",
    )
  })
})

describe('the plane "no answer"', () => {
  // The search says "no answer" when its top hit has a p(answers) below
  // `answerAt` (CTX-1561). `keepAt` stays the threshold of get_related.
  it("reads answerAt of the run, and keepAt for a run from before it", async () => {
    const dataset = await readDataset(datasetFile)
    const id = "billing-provider"
    const planeNoAnswer = (
      loop: { keepAt: number; [setting: string]: number },
      scores: number[],
    ) =>
      buildReport({
        manifest: {
          datasetVersion: dataset.version,
          splits: ["dev"],
          now: "2026-11-20T00:00:00.000Z",
          settings: {},
          loop,
          mode: "live",
          capUsd: 1,
          spentUsd: 0,
          stopped: false,
        },
        dataset: {
          ...dataset,
          questions: dataset.questions.filter((question) => question.id === id),
        },
        // A report scores a question only with an answer of each arm.
        answers: (["legacy", "plane"] as const).map((arm) => ({
          arm,
          question: id,
          search: {
            refs: scores.map((_, index) => `doc-${index}.md`),
            scores,
            latencyMs: 10,
          },
          calls: {
            jev: 2,
            jevQuestions: 100,
            embedding: 1,
            costUsd: 0.001,
            missing: 0,
            failed: 0,
            unrecorded: 0,
          },
        })),
        kept: null,
      }).questions.find((question) => question.arm === "plane")?.metrics
        .noAnswer
    const loop = { ...ORCHESTRATOR_DEFAULTS }
    expect(loop.answerAt).toBe(0.6)
    expect(loop.keepAt).toBe(0.5)
    expect(planeNoAnswer(loop, [0.58, 0.58, 0.33])).toBe(1)
    expect(planeNoAnswer(loop, [0.6, 0.2])).toBe(0)
    expect(planeNoAnswer({ keepAt: 0.5 }, [0.58, 0.58, 0.33])).toBe(0)
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
          calls: { ...calls, missing: 0, failed: 0, unrecorded: 0 },
        },
        {
          arm: "plane",
          question: id,
          search: { error: "internal", latencyMs: 10 },
          calls: { ...calls, missing: 0, failed: 0, unrecorded: 0 },
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

describe("the commands that call a model", () => {
  it("stop at setup when no provider allowlist is set, or when the model settings do not point at OpenRouter", async () => {
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "")
    try {
      for (const command of [
        "draft",
        "label",
        "hydrate",
        "run",
        "latency",
        "vision",
      ])
        await expect(main([command, "--out", "/nowhere"])).rejects.toThrow(
          /^Set MODEL_PROVIDER_ALLOWLIST/,
        )
      vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "azure")
      vi.stubEnv("MODEL_PROVIDER", "bedrock")
      await expect(main(["run", "--out", "/nowhere"])).rejects.toThrow(
        /^MODEL_PROVIDER_ALLOWLIST needs model settings that point at OpenRouter/,
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("finalize", () => {
  it("gives each document one position, and drops and lists the questions that the rules reject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-finalize-"))
    try {
      const dataset = await readDataset(datasetFile)
      const disagreement = dataset.questions.filter(
        (question) => question.category === "disagreement",
      )
      const [first, second] = disagreement
      if (!first || !second) throw new Error("The example needs two.")
      const labeled = join(dir, "labeled.json")
      writeFileSync(
        labeled,
        JSON.stringify({
          ...dataset,
          questions: [
            // A copy of a position: one position for each document.
            {
              ...first,
              positions: [...(first.positions ?? []), first.positions?.[0]],
            },
            // All current: no disagreement.
            {
              ...second,
              positions: second.positions?.map((position) => ({
                ...position,
                status: "current",
              })),
            },
          ],
        }),
      )
      const out = join(dir, "dataset.json")
      await expect(
        main(["finalize", "--out", out, "--draft", labeled]),
      ).resolves.toBe(0)
      const result = await readDataset(out)
      expect(result.questions.map((question) => question.id)).toEqual([
        first.id,
      ])
      expect(result.questions[0]?.positions).toEqual(first.positions)
      expect(
        JSON.parse(readFileSync(`${out}.dropped.json`, "utf8")).dropped,
      ).toEqual([
        {
          question: second.id,
          reason:
            "a disagreement question needs a position that is not current",
        },
      ])
      // The same question in two files is a fault of the input.
      await expect(
        main(["finalize", "--out", out, "--draft", `${labeled},${labeled}`]),
      ).rejects.toThrow(`The labeled files hold ${first.id} twice.`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
  /** From this call on, the workspace budget of OpenRouter is spent. */
  let budgetAt = Number.POSITIVE_INFINITY
  useMswServer(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      if (asked.length >= capAt)
        return HttpResponse.json({ error: "capped" }, { status: 503 })
      if (asked.length >= budgetAt)
        return HttpResponse.json(
          {
            error: {
              code: 403,
              message: "Workspace daily budget of $30.00 exceeded.",
            },
          },
          { status: 403 },
        )
      const body = (await request.json()) as {
        model: string
        messages: { content: string }[]
        provider: unknown
      }
      providers.push(body.provider)
      contents.push(body.messages[0]?.content ?? "")
      const time =
        /^You check a time question.*Question: <data>(.*?)<\/data>/s.exec(
          body.messages[0]?.content ?? "",
        )
      if (time) {
        asked.push(body.model)
        // Two models of three say that "When did it change?" depends on
        // its time; one says that "Which rule holds?" does.
        const dependsOnTime =
          time[1] === "When did it change?" ||
          body.model === "anthropic/judge-a"
        return HttpResponse.json({
          choices: [
            { message: { content: JSON.stringify({ dependsOnTime }) } },
          ],
        })
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
      nearest: async () => [],
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
      nearest: async () => [],
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

  it("keeps a no-answer question only when no nearest document gets a majority that it answers", async () => {
    asked.length = 0
    const noAnswer = (id: string) => ({
      id,
      corpus: "corpus",
      category: "no-answer" as const,
      split: "dev" as const,
      text: `Where is the ${id} feature?`,
      gold: [],
      keyFacts: [],
    })
    const labeled = await labelWithPanel({
      draft: {
        ...draft,
        questions: [
          noAnswer("absent"),
          noAnswer("present"),
          noAnswer("nowhere"),
        ],
      },
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      // One model of three says that lonely.md answers; two say that
      // new.md answers.
      // No document is near the "nowhere" question.
      nearest: async (_corpus, text) =>
        text.includes("absent")
          ? ["lonely.md"]
          : text.includes("nowhere")
            ? []
            : ["lonely.md", "new.md"],
      env,
      stopped: () => false,
    })
    expect(asked).toHaveLength(9)
    expect(labeled.dataset.questions.map((question) => question.id)).toEqual([
      "absent",
    ])
    expect(labeled.dropped).toEqual([
      { question: "present", reason: "the corpus answers it: new.md" },
      {
        question: "nowhere",
        reason: "no nearest document for the panel to judge",
      },
    ])
  })

  it("keeps a time question only when most models say that its answer depends on its time", async () => {
    asked.length = 0
    const time = (id: string, text: string) => ({
      id,
      corpus: "corpus",
      category: "time" as const,
      split: "dev" as const,
      text,
      gold: ["new.md"],
      keyFacts: ["It changed in 2024-01."],
    })
    const labeled = await labelWithPanel({
      draft: {
        ...draft,
        questions: [
          time("changed", "When did it change?"),
          time("holds", "Which rule holds?"),
        ],
      },
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      nearest: async () => [],
      env,
      stopped: () => false,
    })
    // For each question: 3 votes on new.md, then 3 on the time.
    expect(asked).toHaveLength(12)
    expect(labeled.dataset.questions.map((question) => question.id)).toEqual([
      "changed",
    ])
    expect(labeled.dropped).toEqual([
      {
        question: "holds",
        reason: "the answer does not depend on the time of the question",
      },
    ])
    expect(labeled.timeVotes.map((vote) => vote.dependsOnTime)).toEqual([
      true,
      false,
    ])
  })

  it("counts a needed step of a chain as gold for a multi-hop or across-sources question only", async () => {
    contents.length = 0
    const question = (category: "multi-hop" | "lookup") => ({
      id: category,
      corpus: "corpus",
      category,
      split: "dev" as const,
      text: "Which rule follows from the chain?",
      gold: ["old.md"],
      ...(category === "multi-hop" ? { seeds: ["old.md"] } : {}),
      keyFacts: ["The chain gives the rule."],
    })
    await labelWithPanel({
      draft: {
        ...draft,
        questions: [question("multi-hop"), question("lookup")],
      },
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      nearest: async () => [],
      env,
      stopped: () => false,
    })
    expect(contents).toHaveLength(6)
    const [chain, lookup] = [contents[0] ?? "", contents[3] ?? ""]
    expect(chain).toContain("is a needed step to the answer")
    expect(lookup).not.toContain("needed step")
  })

  it("gives a document of two drafted positions one position", async () => {
    const labeled = await labelWithPanel({
      draft: {
        ...draft,
        questions: [
          {
            id: "twice",
            corpus: "corpus",
            category: "disagreement",
            split: "dev",
            text: "Which rule is current?",
            gold: ["old.md", "new.md"],
            seeds: ["new.md"],
            // old.md is in two drafted positions.
            positions: [
              { refs: ["old.md"], status: "superseded" },
              { refs: ["old.md", "new.md"], status: "current" },
            ],
            keyFacts: ["The new rule is current."],
          },
        ],
      },
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      nearest: async () => [],
      env,
      stopped: () => false,
    })
    expect(labeled.dataset.questions[0]?.positions).toEqual([
      { refs: ["old.md"], status: "superseded" },
      { refs: ["new.md"], status: "current" },
    ])
  })

  it("drops a multi-hop question when the panel removes one of its documents", async () => {
    const labeled = await labelWithPanel({
      draft: {
        ...draft,
        questions: [
          {
            id: "chain",
            corpus: "corpus",
            category: "multi-hop",
            split: "dev",
            text: "Which rule follows from the chain?",
            // One model of three says that noise.md answers.
            gold: ["old.md", "noise.md"],
            seeds: ["old.md"],
            keyFacts: ["The chain gives the rule."],
          },
        ],
      },
      models: Object.keys(replies),
      read: async (_corpus, ref) => `The text of ${ref}.`,
      nearest: async () => [],
      env,
      stopped: () => false,
    })
    expect(labeled.dataset.questions).toEqual([])
    expect(labeled.dropped).toEqual([
      {
        question: "chain",
        reason: "the panel removed the needed document noise.md",
      },
    ])
  })

  it("sends each judge call with the provider block of ADR-070", async () => {
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "openai,anthropic")
    providers.length = 0
    try {
      await labelWithPanel({
        draft: { ...draft, questions: draft.questions.slice(1, 2) },
        models: Object.keys(replies),
        read: async (_corpus, ref) => `The text of ${ref}.`,
        nearest: async () => [],
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
        nearest: async () => [],
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

  it("stops as at the spend cap when the workspace budget is spent, and keeps the votes before", async () => {
    asked.length = 0
    budgetAt = 3
    try {
      const labeled = await labelWithPanel({
        draft,
        models: Object.keys(replies),
        read: async (_corpus, ref) => `The text of ${ref}.`,
        nearest: async () => [],
        env,
        stopped: () => false,
      })
      expect(labeled.stopped).toBe(true)
      expect(labeled.budget).toEqual({ limitUsd: 30 })
      expect(labeled.votes.map((vote) => vote.ref)).toEqual(["old.md"])
    } finally {
      budgetAt = Number.POSITIVE_INFINITY
    }
  })

  it("sends nothing when the model provider is not OpenRouter", async () => {
    asked.length = 0
    await expect(
      labelWithPanel({
        draft,
        models: Object.keys(replies),
        read: async (_corpus, ref) => `The text of ${ref}.`,
        nearest: async () => [],
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
