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
/** The embedding requests of the old stack (its own dimension). */
let legacyEmbeddings = 0

/**
 * The fixed Jev replies. The layer judge gives a high p(answers) and
 * p(explore) to a candidate whose text holds the title of a gold document
 * of the question, else a low one. The relation line before the text names
 * the parent, so it does not count (CTX-1578). In the disagreement step, each pair makes
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
    const candidate = String(body.state[index + 1]).replace(
      /(?:".*" \S+ this document\.|This document \S+ ".*"\.)\n\n/,
      "",
    )
    const relevant = titles.some((title) => candidate.includes(title))
    answers[`answers.${n}`] = { type: "noul", noul: relevant ? 0.9 : 0.1 }
    answers[`explore.${n}`] = { type: "noul", noul: relevant ? 0.9 : 0.1 }
    // Only a search with `statesAnswerAt` above 0 asks it (CTX-1685).
    if (`states.${n}` in body.questions)
      answers[`states.${n}`] = { type: "noul", noul: relevant ? 0.7 : 0.1 }
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
    if (!plane) legacyEmbeddings += 1
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
    // Short, so that the test is fast. The command waits 31 s.
    quietMs: 200,
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
    // An eval runs with no time budget, and it keeps the budget of the
    // product to show the answers that would be over it.
    expect(live.run.loop.timeBudgetMs).toBe(0)
    expect(live.run.productBudgetMs).toBe(3_000)
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
      // one call for the disagreement facts). Embeddings of the old stack:
      // 1 for a search, 1 for get_related. The plane keeps the vector of the
      // search, and get_related asks the same text: 1 for each question.
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
          jevQuestions: 36.75,
          embedding: 1,
          errors: 0,
          partial: 0,
        },
        {
          arm: "plane",
          split: "holdout",
          jev: 3,
          jevQuestions: 49,
          embedding: 1,
          errors: 0,
          partial: 0,
        },
      ],
      // 30 Jev calls at $0.001, and 29 embedding calls with no cost in the
      // answer, at the upper estimate of $0.001.
      costUsd: 0.059,
    })
    const markdown = await readFile(join(folder, "live", "report.md"), "utf8")
    const firstTable = markdown.slice(markdown.indexOf("\n## "))
    expect(firstTable).toMatch(
      /^\n## Comparison with the baseline: current stack \(Postgres \+ FalkorDB\)/,
    )
    expect(markdown).toContain(
      '| holdout | no-answer | 1 | correct "no answer" | 0.000 | 1.000 | +1.000 |',
    )
    // The regression checks (CTX-1518) read the first page of each search,
    // the get_related results and the latency of the first calls. The
    // example has no GitHub hit and no stale label.
    expect(markdown).toContain("## Regression checks")
    for (const arm of ["legacy", "plane"] as const)
      expect(live.checks[arm]).toEqual({
        duplicateSlots: expect.any(Number),
        headingOnlyHits: expect.any(Number),
        botBestChunk: null,
        hubSlots: expect.any(Number),
        liveFirst: null,
        noAnswerSeparation: expect.any(Number),
        coldSearchMs: expect.any(Number),
        coldRelatedMs: expect.any(Number),
        pageBytes: expect.any(Number),
      })
    const kept = await readRun(join(folder, "live"))
    expect(kept.answers).toHaveLength(24)
    // The run waited the quiet time before the first search and the first
    // get_related of each arm, and only before them.
    const quiet = kept.answers.flatMap((answer) =>
      [answer.search, answer.related].flatMap((call) =>
        call?.quietMs === undefined ? [] : [call.quietMs],
      ),
    )
    expect(quiet).toHaveLength(4)
    for (const ms of quiet) expect(ms).toBeGreaterThanOrEqual(200)
    // The raw Jev answers and the vectors are in the run folder.
    const jev = kept.calls.filter((call) => call.kind === "jev")
    expect(jev).toHaveLength(30)
    expect(JSON.parse(jev[0]?.response ?? "{}")).toHaveProperty("answers")
    expect(kept.calls.filter((call) => call.kind === "embedding")).toHaveLength(
      29,
    )
    // Each client of both arms sent the provider block (ADR-070).
    for (const call of kept.calls)
      expect(call.request).toMatchObject({
        provider: { data_collection: "deny", zdr: true },
      })
  })

  it("--baseline-from: reuses the stored answers of the old stack, and runs only the plane", async () => {
    const stored = await readRun(join(folder, "live"))
    const before = legacyEmbeddings
    const candidate = await run("candidate", {
      // Another clock: the run takes the query time of the stored run.
      now: new Date("2027-01-01T00:00:00.000Z"),
      baseline: { folder: join(folder, "live"), run: stored },
    })
    // The old stack made no call.
    expect(legacyEmbeddings).toBe(before)
    expect(candidate.status).toBe("complete")
    expect(candidate.run.now).toBe(stored.manifest.now)
    expect(candidate.run.baselineFrom).toBe(join(folder, "live"))
    const recorded = await readRun(join(folder, "candidate"))
    const legacy = (answers: typeof stored.answers) =>
      answers.filter((answer) => answer.arm === "legacy")
    expect(legacy(recorded.answers)).toEqual(legacy(stored.answers))
    // The folder keeps the calls of the reused answers for a replay.
    expect(recorded.calls.filter((call) => call.arm === "legacy")).toEqual(
      stored.calls.filter((call) => call.arm === "legacy"),
    )
    // The same answers of both arms give the same comparison.
    expect(compact(candidate).comparison).toEqual(compact(live).comparison)
    expect(
      await readFile(join(folder, "candidate", "report.md"), "utf8"),
    ).toContain(
      `The baseline answers are the stored answers of ${join(folder, "live")}`,
    )
  })

  it("--baseline-from: refuses another dataset version, other labels, another snapshot, or a missing answer", async () => {
    const stored = await readRun(join(folder, "live"))
    const before = { ...requests }
    const from = (run: typeof stored) => ({
      baseline: { folder: join(folder, "live"), run },
    })
    await expect(
      run(
        "refused",
        from({
          ...stored,
          manifest: { ...stored.manifest, datasetVersion: "other" },
        }),
      ),
    ).rejects.toThrow(/has dataset version other, and the run has version/)
    const [first, ...rest] = stored.dataset.questions
    if (!first) throw new Error("The dataset has no question")
    await expect(
      run(
        "refused",
        from({
          ...stored,
          dataset: {
            ...stored.dataset,
            questions: [
              { ...first, gold: [...first.gold, "other.md"] },
              ...rest,
            ],
          },
        }),
      ),
    ).rejects.toThrow(`has other labels for the question ${first.id}`)
    await expect(
      run(
        "refused",
        from({
          ...stored,
          dataset: {
            ...stored.dataset,
            corpora: stored.dataset.corpora.map((corpus) => ({
              ...corpus,
              contextRepo: { ...corpus.contextRepo, sha: "e".repeat(40) },
            })),
          },
        }),
      ),
    ).rejects.toThrow(/has another snapshot of the corpus/)
    await expect(
      run(
        "refused",
        from({
          ...stored,
          answers: stored.answers.filter(
            (answer) =>
              !(answer.arm === "legacy" && answer.question === first.id),
          ),
        }),
      ),
    ).rejects.toThrow(
      `has no complete answer of the old stack to the question ${first.id}`,
    )
    // An answer with a failed call is no baseline either.
    await expect(
      run(
        "refused",
        from({
          ...stored,
          answers: stored.answers.map((answer) =>
            answer.arm === "legacy" && answer.question === first.id
              ? { ...answer, calls: { ...answer.calls, failed: 1 } }
              : answer,
          ),
        }),
      ),
    ).rejects.toThrow(
      `has no complete answer of the old stack to the question ${first.id}`,
    )
    // A refusal comes before any call.
    expect(requests).toEqual(before)
  })

  it("--reuse-from: an unchanged code path gives the same scores, with no model call", async () => {
    const stored = await readRun(join(folder, "live"))
    const before = { ...requests }
    const reused = await run("reuse-same", {
      // Another clock: the run takes the query time of the reused run.
      now: new Date("2027-01-01T00:00:00.000Z"),
      reuse: { folder: join(folder, "live"), run: stored },
    })
    // Each request was the same as a recorded one, so none went out.
    expect(requests).toEqual(before)
    expect(reused.status).toBe("complete")
    expect(reused.run.mode).toBe("reuse")
    expect(reused.run.now).toBe(stored.manifest.now)
    expect(reused.run.reuse?.live).toBe(0)
    expect(reused.run.reuse?.reused).toBeGreaterThan(0)
    expect(reused.run.spentUsd).toBe(0)
    // The same answers give the same score for each question and arm.
    const scores = (report: Report) =>
      report.questions.map(({ arm, question, metrics }) => ({
        arm,
        question,
        metrics,
      }))
    expect(scores(reused)).toEqual(scores(live))
    expect(compact(reused).comparison).toEqual(compact(live).comparison)
    // A reused call answers at once, so the run gives no latency.
    const markdown = await readFile(
      join(folder, "reuse-same", "report.md"),
      "utf8",
    )
    expect(markdown).toContain("so it gives no latency")
    expect(markdown).toContain(
      `The run reused ${reused.run.reuse?.reused} recorded model calls of ${join(folder, "live")}, and sent 0 new calls`,
    )
  })

  it("--reuse-from: a changed request goes out live, and the other calls are reused", async () => {
    const stored = await readRun(join(folder, "live"))
    const before = { ...requests }
    // Less evidence text changes the state of each layer-judge request, and
    // no query text: the Jev calls go out, the embeddings are reused.
    const changed = await run("reuse-changed", {
      settings: { evidenceChars: 200 },
      reuse: { folder: join(folder, "live"), run: stored },
    })
    expect(changed.status).toBe("complete")
    expect(requests.embedding).toBe(before.embedding)
    expect(requests.jev).toBeGreaterThan(before.jev)
    expect(changed.run.reuse?.live).toBe(requests.jev - before.jev)
    expect(changed.run.reuse?.reused).toBeGreaterThan(0)
    expect(changed.run.spentUsd).toBeGreaterThan(0)
    // The folder holds each call of the run, so a rescore of it replays.
    const recorded = await readRun(join(folder, "reuse-changed"))
    const rescored = await run("reuse-changed-rescore", {
      settings: { evidenceChars: 200 },
      capUsd: 0,
      replay: { calls: recorded.calls },
      now: new Date(recorded.manifest.now),
    })
    expect(rescored.incomplete).toEqual([])
    expect(requests.jev).toBe(before.jev + (changed.run.reuse?.live ?? 0))
  })

  it("--reuse-from: a recorded failure goes out again, and a call that the spend cap stops is not counted as sent", async () => {
    const stored = await readRun(join(folder, "live"))
    const failedAt = stored.calls.findIndex(
      (call) => call.arm === "plane" && call.kind === "jev",
    )
    expect(failedAt).toBeGreaterThanOrEqual(0)
    // The kept run got an HTTP 503 for one Jev request.
    const withFailure = {
      ...stored,
      calls: stored.calls.map((call, index) =>
        index === failedAt ? { ...call, status: 503 } : call,
      ),
    }
    const before = { ...requests }
    const again = await run("reuse-failure", {
      reuse: { folder: join(folder, "live"), run: withFailure },
    })
    // Only that request went out, and its new answer is used.
    expect(requests.jev).toBe(before.jev + 1)
    expect(requests.embedding).toBe(before.embedding)
    expect(again.run.reuse?.live).toBe(1)
    expect(again.errors).toBe(0)
    // With no money left, the same request does not go out, and it is not
    // counted as a sent call.
    const capped = await run("reuse-capped", {
      capUsd: 0,
      reuse: { folder: join(folder, "live"), run: withFailure },
    })
    expect(requests.jev).toBe(before.jev + 1)
    expect(capped.run.reuse?.live).toBe(0)
    expect(capped.run.stopped).toBe(true)
  })

  it("--reuse-from: refuses other labels, and another query time than --baseline-from", async () => {
    const stored = await readRun(join(folder, "live"))
    const before = { ...requests }
    const [first, ...rest] = stored.dataset.questions
    if (!first) throw new Error("The dataset has no question")
    await expect(
      run("refused", {
        reuse: {
          folder: join(folder, "live"),
          run: {
            ...stored,
            dataset: {
              ...stored.dataset,
              questions: [
                { ...first, gold: [...first.gold, "other.md"] },
                ...rest,
              ],
            },
          },
        },
      }),
    ).rejects.toThrow(
      `--reuse-from ${join(folder, "live")} has other labels for the question ${first.id}`,
    )
    await expect(
      run("refused", {
        baseline: { folder: join(folder, "live"), run: stored },
        reuse: {
          folder: join(folder, "live"),
          run: {
            ...stored,
            manifest: { ...stored.manifest, now: "2027-01-01T00:00:00.000Z" },
          },
        },
      }),
    ).rejects.toThrow("--baseline-from and --reuse-from have other query times")
    expect(requests).toEqual(before)
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
    // A rescore gives each regression check from the same stores. keepAt
    // does not change the old stack or the search page of the plane. Check
    // 7 holds only the time of the stores in a replay.
    const cold = {
      coldSearchMs: expect.any(Number),
      coldRelatedMs: expect.any(Number),
    }
    expect(rescored.checks.legacy).toEqual({ ...live.checks.legacy, ...cold })
    const page = ({
      duplicateSlots,
      headingOnlyHits,
      pageBytes,
    }: Report["checks"]["plane"]) => ({
      duplicateSlots,
      headingOnlyHits,
      pageBytes,
    })
    expect(page(rescored.checks.plane)).toEqual(page(live.checks.plane))
    // At a keepAt of 0.95, Jev keeps no hit of the plane (it gave 0.9).
    // Thus each plane search says "no answer", and the retrieval metrics
    // score it as an empty result (CTX-1562): each answerable question gets
    // worse, with recall@5 0. No fact of a disagreement has a position, so
    // the positions get worse too. A gold
    // document of get_related stays a step, because Jev gave it a
    // p(explore) of 0.9 (CTX-1534), so traversal recall stays. A no-answer
    // stays correct.
    const answerable = rescored.questions.filter(
      (question) =>
        question.arm === "plane" && question.category !== "no-answer",
    )
    expect(answerable.length).toBeGreaterThan(0)
    expect(
      rescored.questions
        .filter((question) => question.change !== "same")
        .map(({ arm, question, change }) => ({ arm, question, change })),
    ).toEqual(
      answerable.map(({ question }) => ({
        arm: "plane",
        question,
        change: "worse",
      })),
    )
    expect(answerable.map((question) => question.metrics.recall5)).toEqual(
      answerable.map(() => 0),
    )
    expect(
      answerable.map((question) => question.metrics.traversalRecall),
    ).toEqual(
      answerable.map(
        (question) =>
          live.questions.find(
            (kept) =>
              kept.arm === "plane" && kept.question === question.question,
          )?.metrics.traversalRecall,
      ),
    )
    expect(
      rescored.questions.find(
        (question) =>
          question.arm === "plane" && question.question === "billing-provider",
      )?.metrics.noAnswer,
    ).toBe(1)
    // The keep-or-revert rule reads the plane against the kept run: the
    // retrieval metrics and the positions of the hold-out set get worse, and
    // a replay gives no latency guard.
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
            "ndcg10": -1,
            "noAnswer": 0,
            "positions": -1,
            "recall5": -1,
            "searchRecall50": -1,
            "traversalRecall": 0,
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
            "ndcg10": 0,
            "noAnswer": 1,
            "positions": 0,
            "recall5": 0,
            "searchRecall50": 0,
            "traversalRecall": 1,
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
          jevQuestionsPerQuestion: 36.75,
          costPerQuestionUsd: 0.003,
          errors: 0,
        },
        now: {
          searchP95Ms: null,
          relatedP95Ms: null,
          jevCallsPerQuestion: 2,
          jevQuestionsPerQuestion: 32.5,
          costPerQuestionUsd: 0.002,
          errors: 0,
        },
      },
      {
        split: "holdout",
        questions: 4,
        kept: {
          ...latency,
          jevCallsPerQuestion: 3,
          jevQuestionsPerQuestion: 49,
          costPerQuestionUsd: 0.004,
          errors: 0,
        },
        now: {
          searchP95Ms: null,
          relatedP95Ms: null,
          jevCallsPerQuestion: 3,
          jevQuestionsPerQuestion: 35.75,
          costPerQuestionUsd: 0.003,
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
      "| holdout | all | 4 | positions correct | 1.000 | 0.000 | -1.000 |",
    )
    expect(markdown).toContain(
      "| holdout | 4 | Jev questions / question | 49.000 | 35.750 | -13.250 |",
    )
  })

  it('statesAnswerAt: the search also asks if each hit states the answer, and a rescore moves the "no answer" with no model call', async () => {
    const stored = await readRun(join(folder, "live"))
    const asked = await run("states", {
      settings: { statesAnswerAt: 0.5 },
      reuse: { folder: join(folder, "live"), run: stored },
    })
    expect(asked.status).toBe("complete")
    const recorded = await readRun(join(folder, "states"))
    // Only the search of the plane asks the question, after the two
    // questions of each candidate. get_related sends its recorded requests.
    const judged = recorded.calls.flatMap((call) => {
      const request = call.request as {
        state: string[]
        questions: Record<string, unknown>
      }
      const keys = Object.keys(request.questions ?? {})
      if (!keys.some((key) => key.startsWith("answers."))) return []
      return [
        {
          search: request.state.includes("Intent: <data>search</data>"),
          states: keys.filter((key) => key.startsWith("states.")).length,
          last: keys.at(-1) ?? "",
          candidates: keys.filter((key) => key.startsWith("answers.")).length,
        },
      ]
    })
    expect(judged.some((call) => !call.search)).toBe(true)
    for (const call of judged)
      expect(call).toEqual(
        call.search
          ? {
              ...call,
              states: call.candidates,
              last: `states.${call.candidates}`,
            }
          : { ...call, states: 0 },
      )
    expect(asked.run.reuse?.live).toBe(
      judged.filter((call) => call.search).length,
    )
    // The run records p(states the answer) of each hit of the plane search.
    for (const answer of recorded.answers) {
      const search = "error" in answer.search ? null : answer.search
      expect(search?.statesAnswer?.length).toBe(
        answer.arm === "plane" ? search?.refs.length : undefined,
      )
    }
    // Jev says that each gold hit states the answer with 0.7: at 0.5 each
    // "no answer" is the same as with keepAt alone.
    const metricsOf = (report: Report) =>
      report.questions.map(({ arm, question, metrics }) => ({
        arm,
        question,
        metrics,
      }))
    expect(metricsOf(asked)).toEqual(metricsOf(live))

    // At 0.8, no hit states the answer, so each plane search says "no
    // answer". The recorded calls hold each question, so the rescore makes
    // no model call.
    const before = { ...requests }
    const rescored = await run("states-rescore", {
      settings: { statesAnswerAt: 0.8 },
      capUsd: 0,
      replay: { calls: recorded.calls },
      now: new Date(recorded.manifest.now),
    })
    expect(requests).toEqual(before)
    expect(rescored.incomplete).toEqual([])
    const plane = rescored.questions.filter(
      (question) => question.arm === "plane",
    )
    const recall5 = (report: Report) =>
      report.questions
        .filter(
          (question) =>
            question.arm === "plane" && question.category !== "no-answer",
        )
        .map((question) => question.metrics.recall5)
    expect(recall5(live).some((value) => value && value > 0)).toBe(true)
    expect(recall5(rescored).every((value) => value === 0)).toBe(true)
    expect(
      plane.find((question) => question.question === "billing-provider")
        ?.metrics.noAnswer,
    ).toBe(1)
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
