import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { executeRun } from "../../evals/knowledge/cli.js"
import { readDataset } from "../../evals/knowledge/dataset.js"
import type { Report } from "../../evals/knowledge/report.js"
import { readRun, type Targets } from "../../evals/knowledge/runner.js"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaceKnowledgeUnits, workspaces } from "../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import { knowledgeProjectionVersion } from "../knowledge-plane/change-set.js"
import { createKnowledgeStore } from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../models/knowledge-state.js"
import { textEmbeddingConfig } from "../retrieval/embeddings/textEmbeddings.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import {
  type PlaneDocument,
  writePlaneDocuments,
} from "../test/knowledge-plane.js"
import { embedText, planeVector } from "../test/knowledge-search-fixture.js"
import { dropOrgGraph, seedRelatedWorkspace } from "../test/related-fixture.js"

/*
 * The knowledge eval harness of ADR-069, end to end: the example questions
 * over one Workspace on both stacks (real Postgres, FalkorDB and ClickHouse),
 * with fixed model replies through msw. Then a rescore of the run with a new
 * threshold, from the kept calls only, and a run that the spend cap stops.
 */

const MODEL_URL = "https://eval-model.test/v1"
const now = new Date("2026-11-19T00:00:00Z")
const dataset = await readDataset(
  new URL(
    "../../evals/knowledge/fixtures/ctxpipe-memory.dataset.json",
    import.meta.url,
  ).pathname,
)
/** Both stacks serve the frozen SHA of the corpus. */
const frozenSha = dataset.corpora[0]?.contextRepo.sha ?? ""

type Unit = {
  path: string
  kind: string
  title: string
  body: string
  validFrom?: string
  validTo?: string
  claims?: { to: string; predicate: string; confidence: number }[]
}
const { units } = JSON.parse(
  await readFile(
    new URL(
      "../../evals/knowledge/fixtures/ctxpipe-memory.workspace.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { units: Unit[] }

/** The claims of a unit, with the validity window of the unit. */
const claimsOf = (unit: Unit) =>
  (unit.claims ?? []).map((claim) => ({
    ...claim,
    validFrom: unit.validFrom ?? null,
    validTo: unit.validTo ?? null,
  }))

/** The text of a unit, as both stacks index it. */
const unitText = (unit: Unit) => `${unit.title}\n\n${unit.body}`

/** The model requests that reached msw, by kind. */
const requests = { jev: 0, embedding: 0 }

/**
 * The fixed Jev replies. The layer judge gives a high p(answers) and
 * p(explore) to a candidate that holds the title of a gold document of the
 * question, else a low one. In the disagreement step, each pair makes
 * claims about the same part of the question and disagrees, and an item
 * changes or replaces the claim of an item whose text says "Superseded by"
 * when its own text does not. No claim is scoped. Each reply costs $0.001.
 */
function jevReply(
  body: { state: unknown[]; questions: Record<string, unknown> },
  goldTitles: (question: string) => string[],
) {
  const keys = Object.keys(body.questions)
  const text = body.state.filter((part) => typeof part === "string").join("\n")
  const question = /Question: <data>(.*?)<\/data>/.exec(text)?.[1] ?? ""
  const titles = goldTitles(question)
  const usage = { cost: 0.001 }
  if (!keys.some((key) => /^(answers|explore)\./.test(key))) {
    const superseded = new Set<string>()
    body.state.forEach((part, index) => {
      const n = typeof part === "string" && /^Item (\d+):$/.exec(part)?.[1]
      if (n && String(body.state[index + 1]).includes("Superseded by"))
        superseded.add(n)
    })
    const fact = (key: string) => {
      const [name, from = "", to = ""] = key.split(".")
      if (name === "same" || name === "disagree") return 0.9
      if (name === "replaces")
        return superseded.has(to) && !superseded.has(from) ? 0.9 : 0.1
      return 0.1
    }
    return {
      usage,
      answers: Object.fromEntries(
        keys.map((key) => [key, { type: "noul", noul: fact(key) }]),
      ),
    }
  }
  const answers: Record<string, { type: "noul"; noul: number }> = {}
  body.state.forEach((part, index) => {
    const n = typeof part === "string" && /^Candidate (\d+) \(/.exec(part)?.[1]
    if (!n) return
    const candidate = String(body.state[index + 1])
    const relevant = titles.some((title) => candidate.includes(title))
    answers[`answers.${n}`] = { type: "noul", noul: relevant ? 0.9 : 0.1 }
    answers[`explore.${n}`] = { type: "noul", noul: relevant ? 0.9 : 0.1 }
  })
  return { usage, answers }
}

let goldTitlesByQuestion = new Map<string, string[]>()

const models = setupServer(
  http.post(`${MODEL_URL}/embeddings`, async ({ request }) => {
    requests.embedding += 1
    const body = (await request.json()) as {
      input: string[]
      dimensions?: number
    }
    // Both stacks use one model; the plane asks for its own dimension.
    const plane = body.dimensions === textEmbeddingConfig.dimensions
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding: plane ? planeVector(input) : embedText(input),
      })),
    })
  }),
  http.post("https://eval-model.test/alpha/decisions", async ({ request }) => {
    requests.jev += 1
    const body = (await request.json()) as {
      state: unknown[]
      questions: Record<string, unknown>
    }
    return HttpResponse.json(
      jevReply(body, (question) => goldTitlesByQuestion.get(question) ?? []),
    )
  }),
)

/** The root of the example corpus. */
const root = dataset.corpora[0]?.contextRepo.root ?? ""
let seededWorkspace: string

/** Record a complete plane run of the frozen SHA at the root `of`. */
async function projectPlane(of: string) {
  const key = { orgId: seed.orgId, workspaceId: seededWorkspace }
  await beginKnowledgeRun({ ...key, branch: "main", isDefault: true })
  await completeKnowledgeRun({
    ...key,
    tip: frozenSha,
    branch: "main",
    treeVersion: 1,
    mergeBase: null,
    baseBranch: null,
    projectionVersion: knowledgeProjectionVersion({
      embeddingModel: textEmbeddingConfig.model,
      dimensions: textEmbeddingConfig.dimensions,
      root: of,
      converter: "fixture",
      visionModel: "fixture",
    }),
    failedCount: 0,
  })
}

let seed: SeededOrg
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let folder: string
let targets: Targets

/** The rows of the fixture units in the knowledge plane. */
function planeRows(workspaceId: string): PlaneDocument[] {
  const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const observedAt = new Date("2026-11-01T00:00:00Z")
  const date = (value: string | null | undefined) =>
    value ? new Date(value) : null
  return units.map((unit) => ({
    document: {
      docKey: key(unit.path),
      kind: unit.kind,
      title: unit.title,
      path: unit.path,
      sourceType: "docs",
      source: "",
      summary: unit.title,
      mime: "",
      validFrom: date(unit.validFrom),
      validTo: date(unit.validTo),
      observedAt,
    },
    chunks: [
      {
        ordinal: 0,
        text: unitText(unit),
        startLine: 1,
        endLine: 3,
        embedding: planeVector(`${unit.title} ${unit.body}`),
      },
    ],
    relations: claimsOf(unit).map((claim) => ({
      srcChunk: 0,
      predicate: claim.predicate,
      dstDoc: key(claim.to),
      confidence: claim.confidence,
      validFrom: date(claim.validFrom),
      validTo: date(claim.validTo),
      source: "",
      altText: "",
      observedAt,
    })),
  }))
}

const run = async (
  name: string,
  options: Partial<Parameters<typeof executeRun>[0]> = {},
) =>
  executeRun({
    dataset,
    targets,
    splits: ["dev", "holdout"],
    settings: {},
    capUsd: 5,
    now,
    out: join(folder, name),
    kept: null,
    ...options,
  })

describe("the knowledge eval harness", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    // As `factory eval` runs the harness.
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", MODEL_URL)
    // ClickHouse and FalkorDB are real servers.
    models.listen({ onUnhandledRequest: "bypass" })
    folder = await mkdtemp(join(tmpdir(), "knowledge-eval-"))
    const titleOf = new Map(units.map((unit) => [unit.path, unit.title]))
    goldTitlesByQuestion = new Map(
      dataset.questions.map((question) => [
        question.text,
        question.gold.map((path) => titleOf.get(path) ?? path),
      ]),
    )
    clickHouse = await startClickHouse()
    const url = await clickHouse.freshDatabase()
    await migrateKnowledgeStore(url, {
      reader: "reader-test",
      writer: "writer-test",
    })
    // The backend reads as the reader user, with SELECT only.
    vi.stubEnv("CLICKHOUSE_URL", userUrl(url, "ctxpipe_reader", "reader-test"))
    seed = await seedOrg()
    const { workspaceId, revision } = await seedRelatedWorkspace({
      seed,
      slug: "memory",
      sha: frozenSha,
      units: units.map((unit) => ({
        ...unit,
        body: `# ${unit.title}\n\n${unit.body}`,
        claims: claimsOf(unit).map((claim) => ({
          ...claim,
          validFrom: claim.validFrom ?? undefined,
          validTo: claim.validTo ?? undefined,
        })),
      })),
      chunks: true,
    })
    seededWorkspace = workspaceId
    // The gold paths are relative to the root of the corpus, and the old
    // stack serves that root.
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({
          rootPath: root,
          activeRevision: { ...revision, rootPath: root },
        })
        .where(eq(workspaces.id, workspaceId)),
    )
    // The search of the old stack reads the claims of a unit for `validAt`.
    await withOrgDbContext(seed.orgId, async (db) => {
      for (const unit of units)
        await db
          .update(workspaceKnowledgeUnits)
          .set({
            claims: claimsOf(unit).map((claim) => ({ ...claim, source: null })),
          })
          .where(
            and(
              eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
              eq(workspaceKnowledgeUnits.path, unit.path),
            ),
          )
    })
    const writer = createKnowledgeStore(url)
    try {
      await writePlaneDocuments(
        writer,
        { orgId: seed.orgId, workspaceId },
        planeRows(workspaceId),
      )
    } finally {
      await writer.close()
    }
    await projectPlane(root)
    targets = {
      "ctxpipe-memory-v0": {
        orgId: seed.orgId,
        orgSlug: seed.orgSlug,
        workspace: "memory",
      },
    }
  }, 240_000)

  afterAll(async () => {
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await dropOrgGraph(seed.orgId)
      await cleanupSeededOrg(seed)
    }
    await clickHouse?.stop()
    if (folder) await rm(folder, { recursive: true, force: true })
    models.close()
    vi.unstubAllEnvs()
  })

  let live: Report

  /** The baseline comparison of each split, and the calls and cost of each arm. */
  const compact = (report: Report) => ({
    comparison: Object.fromEntries(
      report.comparison
        .filter((row) => row.category === "all")
        .map((row) => [
          row.split,
          Object.fromEntries(
            Object.entries({ legacy: row.baseline, plane: row.plane }).map(
              ([arm, metrics]) => [
                arm,
                Object.fromEntries(
                  Object.entries(metrics).map(([metric, value]) => [
                    metric,
                    value === null ? null : Number(value.toFixed(3)),
                  ]),
                ),
              ],
            ),
          ),
        ]),
    ),
    calls: report.operations.map((row) => ({
      arm: row.arm,
      split: row.split,
      jev: row.jevCallsPerQuestion,
      jevQuestions: row.jevQuestionsPerQuestion,
      embedding: row.embeddingCallsPerQuestion,
      errors: row.errors,
      partial: row.partial,
    })),
    costUsd: Number(report.costUsd.toFixed(4)),
  })

  it("runs each question through both arms and writes the run folder and the report", async () => {
    live = await run("live")
    expect(live.status).toBe("complete")
    // Jev agrees with the gold labels, so the plane is right each time. The
    // old stack ranks some gold documents lower, and it has no "no answer".
    expect(compact(live)).toEqual({
      comparison: {
        dev: {
          legacy: {
            recall5: 1,
            ndcg10: 0.979,
            searchRecall50: 1,
            traversalRecall: 1,
            noAnswer: 0,
            positions: null,
          },
          plane: {
            recall5: 1,
            ndcg10: 1,
            searchRecall50: 1,
            traversalRecall: 1,
            noAnswer: 1,
            positions: 1,
          },
        },
        holdout: {
          legacy: {
            recall5: 1,
            ndcg10: 0.839,
            searchRecall50: 1,
            traversalRecall: 1,
            noAnswer: 0,
            positions: null,
          },
          plane: {
            recall5: 1,
            ndcg10: 1,
            searchRecall50: 1,
            traversalRecall: 1,
            noAnswer: 1,
            positions: 1,
          },
        },
      },
      // Jev: 1 call for a search; 4 or 5 for get_related (the layers, and
      // one call for the disagreement facts). Embeddings: 1 for a search, 1
      // for get_related.
      calls: [
        {
          arm: "legacy",
          split: "dev",
          jev: 0,
          jevQuestions: 0,
          embedding: 1.375,
          errors: 0,
          partial: 0,
        },
        {
          arm: "legacy",
          split: "holdout",
          jev: 0,
          jevQuestions: 0,
          embedding: 1.5,
          errors: 0,
          partial: 0,
        },
        {
          arm: "plane",
          split: "dev",
          jev: 2.25,
          jevQuestions: 34,
          embedding: 1.375,
          errors: 0,
          partial: 0,
        },
        {
          arm: "plane",
          split: "holdout",
          jev: 3,
          jevQuestions: 39.25,
          embedding: 1.5,
          errors: 0,
          partial: 0,
        },
      ],
      // 30 Jev calls at $0.001, and 34 embedding calls with no cost in the
      // answer, at the upper estimate of $0.001.
      costUsd: 0.064,
    })
    const markdown = await readFile(join(folder, "live", "report.md"), "utf8")
    const firstTable = markdown.slice(markdown.indexOf("\n## "))
    expect(firstTable).toMatch(
      /^\n## Comparison with the baseline: current stack \(Postgres \+ FalkorDB\)/,
    )
    expect(markdown).toContain(
      '| holdout | no-answer | 1 | correct "no answer" | 0.000 | 1.000 | +1.000 |',
    )
    const kept = await readRun(join(folder, "live"))
    expect(kept.answers).toHaveLength(24)
    // The raw Jev answers and the vectors are in the run folder.
    const jev = kept.calls.filter((call) => call.kind === "jev")
    expect(jev).toHaveLength(30)
    expect(JSON.parse(jev[0]?.response ?? "{}")).toHaveProperty("answers")
    expect(kept.calls.filter((call) => call.kind === "embedding")).toHaveLength(
      34,
    )
    // Each client of both arms sent the provider block (ADR-070).
    for (const call of kept.calls)
      expect(call.request).toMatchObject({
        provider: { data_collection: "deny", zdr: true },
      })
  })

  it("scores a new threshold again from the kept calls, with no model call", async () => {
    const before = { ...requests }
    const recorded = await readRun(join(folder, "live"))
    const rescored = await run("rescore", {
      settings: { keepAt: 0.95 },
      capUsd: 0,
      kept: live,
      replay: { calls: recorded.calls },
    })
    expect(requests).toEqual(before)
    expect(rescored.run.mode).toBe("replay")
    expect(rescored.incomplete).toEqual([])
    // At 0.95, get_related on the plane keeps no document (Jev gave 0.9),
    // so each question with seeds gets worse; a no-answer stays correct.
    expect(
      rescored.questions
        .filter((question) => question.change !== "same")
        .map(({ arm, question, change }) => ({ arm, question, change })),
    ).toEqual(
      [
        "local-dev-infra",
        "agent-memory",
        "hosted-region",
        "ops-observability",
        "knowledge-store",
      ].map((question) => ({ arm: "plane", question, change: "worse" })),
    )
    expect(
      rescored.questions.find(
        (question) =>
          question.arm === "plane" && question.question === "billing-provider",
      )?.metrics.noAnswer,
    ).toBe(1)
    // The keep-or-revert rule reads the plane against the kept run: the
    // hold-out set gets worse, and a replay gives no latency guard.
    const round = (values: Record<string, number | null>) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          value === null ? null : Number(value.toFixed(3)),
        ]),
      )
    const holdout = rescored.kept?.comparison.find(
      (row) => row.split === "holdout" && row.category === "all",
    )
    expect(holdout && { ...holdout, change: round(holdout.change) })
      .toMatchInlineSnapshot(`
      {
        "category": "all",
        "change": {
          "ndcg10": 0,
          "noAnswer": 0,
          "positions": -1,
          "recall5": 0,
          "searchRecall50": 0,
          "traversalRecall": -1,
        },
        "kept": {
          "ndcg10": 1,
          "noAnswer": 1,
          "positions": 1,
          "recall5": 1,
          "searchRecall50": 1,
          "traversalRecall": 1,
        },
        "now": {
          "ndcg10": 1,
          "noAnswer": 1,
          "positions": 0,
          "recall5": 1,
          "searchRecall50": 1,
          "traversalRecall": 0,
        },
        "questions": 4,
        "split": "holdout",
      }
    `)
    // The live latency of the kept run varies; the replay has none.
    const latency = {
      searchP95Ms: expect.any(Number),
      relatedP95Ms: expect.any(Number),
    }
    expect(
      rescored.kept?.guards.map(({ split, questions, kept, now }) => ({
        split,
        questions,
        kept: round(kept),
        now: round(now),
      })),
    ).toEqual([
      {
        split: "dev",
        questions: 8,
        kept: {
          ...latency,
          jevCallsPerQuestion: 2.25,
          jevQuestionsPerQuestion: 34,
          costPerQuestionUsd: 0.004,
          errors: 0,
        },
        now: {
          searchP95Ms: null,
          relatedP95Ms: null,
          jevCallsPerQuestion: 1.875,
          jevQuestionsPerQuestion: 31.75,
          costPerQuestionUsd: 0.003,
          errors: 0,
        },
      },
      {
        split: "holdout",
        questions: 4,
        kept: {
          ...latency,
          jevCallsPerQuestion: 3,
          jevQuestionsPerQuestion: 39.25,
          costPerQuestionUsd: 0.005,
          errors: 0,
        },
        now: {
          searchP95Ms: null,
          relatedP95Ms: null,
          jevCallsPerQuestion: 2.5,
          jevQuestionsPerQuestion: 34,
          costPerQuestionUsd: 0.004,
          errors: 0,
        },
      },
    ])
    const markdown = await readFile(
      join(folder, "rescore", "report.md"),
      "utf8",
    )
    expect(markdown).toContain("## The plane against the kept run")
    expect(markdown).toContain(
      "| holdout | all | 4 | traversal recall | 1.000 | 0.000 | -1.000 |",
    )
    expect(markdown).toContain(
      "| holdout | 4 | Jev calls / question | 3.000 | 2.500 | -0.500 |",
    )
  })

  it("scores a change of a fact threshold again from the kept calls, with no model call", async () => {
    const before = { ...requests }
    const recorded = await readRun(join(folder, "live"))
    // At 0.95, no item changes or replaces another, so each pair
    // contradicts. The rows tie on each rule, so each position is disputed.
    const rescored = await run("rescore-facts", {
      settings: { replacesAt: 0.95 },
      capUsd: 0,
      kept: live,
      replay: { calls: recorded.calls },
    })
    expect(requests).toEqual(before)
    expect(rescored.incomplete).toEqual([])
    expect(
      rescored.questions
        .filter((question) => question.metrics.positions !== null)
        .map(({ question, metrics }) => ({
          question,
          positions: metrics.positions,
        })),
    ).toEqual([
      { question: "local-dev-infra", positions: 0 },
      { question: "agent-memory", positions: 0 },
      { question: "ops-observability", positions: 0 },
    ])
  })

  it("stops at the spend cap and compares only the questions that both arms answered", async () => {
    const stopped = await run("capped", { capUsd: 0.005 })
    expect(stopped.run.stopped).toBe(true)
    expect(stopped.status).toBe("spend-cap")
    // Each call in flight holds its upper cost, so the spend stays in the cap.
    expect(stopped.run.spentUsd).toBeGreaterThan(0)
    expect(stopped.run.spentUsd).toBeLessThanOrEqual(0.005)
    const recorded = await readRun(join(folder, "capped"))
    expect(recorded.answers.length).toBeGreaterThan(0)
    expect(recorded.answers.length).toBeLessThan(24)
    const scored = stopped.questions.map((question) => question.question)
    expect(scored.length).toBeGreaterThan(0)
    for (const question of new Set(scored))
      expect(scored.filter((id) => id === question)).toHaveLength(2)
    expect(
      await readFile(join(folder, "capped", "report.md"), "utf8"),
    ).toContain("The spend cap stopped the run.")
  })

  it("refuses a Workspace that does not serve the frozen SHA of the corpus", async () => {
    const before = { ...requests }
    await expect(
      run("other-sha", {
        dataset: {
          ...dataset,
          corpora: dataset.corpora.map((corpus) => ({
            ...corpus,
            contextRepo: { ...corpus.contextRepo, sha: "f".repeat(40) },
          })),
        },
      }),
    ).rejects.toThrow(/must serve the frozen SHA f{40}/)
    expect(requests).toEqual(before)
  })

  it("refuses a Workspace whose root is not the root of the corpus", async () => {
    const before = { ...requests }
    await expect(
      run("other-root", {
        dataset: {
          ...dataset,
          corpora: dataset.corpora.map((corpus) => ({
            ...corpus,
            contextRepo: { ...corpus.contextRepo, root: "" },
          })),
        },
      }),
    ).rejects.toThrow(
      'Workspace memory must serve the root "" of ctxpipe-memory on both stacks. The Workspace has ".ai/memory", the old stack serves ".ai/memory", and the plane serves ".ai/memory".',
    )
    expect(requests).toEqual(before)
  })

  it("refuses a plane that serves another root of the frozen SHA", async () => {
    // A failed projection after a change of the root keeps the earlier
    // projection of the same SHA.
    await projectPlane("")
    try {
      await expect(run("plane-root")).rejects.toThrow(
        'the old stack serves ".ai/memory", and the plane serves "".',
      )
    } finally {
      await projectPlane(root)
    }
  })
})
