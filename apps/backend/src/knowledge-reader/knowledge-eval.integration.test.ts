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
import {
  createKnowledgeStore,
  type DocumentRows,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../models/knowledge-state.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import { embedText } from "../test/knowledge-search-fixture.js"
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

/** The vector of a text on both stacks: the old stack has 2000 dimensions. */
const planeVector = (text: string) => embedText(text).slice(0, 1024)

/** The text of a unit, as both stacks index it. */
const unitText = (unit: Unit) => `${unit.title}\n\n${unit.body}`

/** The model requests that reached msw, by kind. */
const requests = { jev: 0, embedding: 0 }

/**
 * The fixed Jev replies. The layer judge gives a high p(answers) and
 * p(explore) to a candidate that holds the title of a gold document of the
 * question, else a low one. In the disagreement step, each pair "updates",
 * and a position whose text says "Superseded by" is superseded, else
 * current. Each reply costs $0.001.
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
  if (keys.every((key) => key.startsWith("pair."))) {
    return {
      usage,
      answers: Object.fromEntries(
        keys.map((key) => [
          key,
          {
            type: "choice",
            probabilities: {
              agrees: 0.05,
              contradicts: 0.05,
              partial: 0.05,
              updates: 0.8,
              unrelated: 0.05,
            },
          },
        ]),
      ),
    }
  }
  if (keys.every((key) => key.startsWith("status."))) {
    // The state lists "Position N:", then the items of the position.
    const sections = text.split(/^Position (\d+):$/m)
    const superseded = new Set<string>()
    for (let index = 1; index < sections.length; index += 2) {
      const section = (sections[index + 1] ?? "").split(
        "Relations between the positions:",
      )[0]
      if (section?.includes("Superseded by"))
        superseded.add(`status.${sections[index]}`)
    }
    return {
      usage,
      answers: Object.fromEntries(
        keys.map((key) => {
          const top = superseded.has(key) ? "superseded" : "current"
          return [
            key,
            {
              type: "choice",
              probabilities: Object.fromEntries(
                ["current", "superseded", "disputed", "scoped"].map(
                  (status) => [status, status === top ? 0.8 : 0.05],
                ),
              ),
            },
          ]
        }),
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
      input: (string | { content: { text?: string }[] })[]
    }
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding:
          typeof input === "string"
            ? embedText(input)
            : planeVector(input.content[0]?.text ?? ""),
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

let seed: SeededOrg
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let folder: string
let targets: Targets

/** The rows of the fixture units in the knowledge plane. */
function planeRows(workspaceId: string): DocumentRows[] {
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
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
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
    const { workspaceId } = await seedRelatedWorkspace({
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
      await writer.applyDocuments({ orgId: seed.orgId, workspaceId }, { documents: planeRows(workspaceId) })
    } finally {
      await writer.close()
    }
    await beginKnowledgeRun({ orgId: seed.orgId, workspaceId, tip: frozenSha })
    await completeKnowledgeRun({
      orgId: seed.orgId,
      workspaceId,
      tip: frozenSha,
      projectionVersion: "test",
      failedCount: 0,
    })
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
      // Jev: 1 call for a search; 5 or 6 for get_related (2 layers, the
      // pairs and the statuses). Embeddings: 1 for a search, 1 for
      // get_related.
      calls: [
        {
          arm: "legacy",
          split: "dev",
          jev: 0,
          embedding: 1.375,
          errors: 0,
          partial: 0,
        },
        {
          arm: "legacy",
          split: "holdout",
          jev: 0,
          embedding: 1.5,
          errors: 0,
          partial: 0,
        },
        {
          arm: "plane",
          split: "dev",
          jev: 2.625,
          embedding: 1.375,
          errors: 0,
          partial: 0,
        },
        {
          arm: "plane",
          split: "holdout",
          jev: 3.5,
          embedding: 1.5,
          errors: 0,
          partial: 0,
        },
      ],
      // 35 Jev calls at $0.001, and 34 embedding calls with no cost in the
      // answer, at the upper estimate of $0.001.
      costUsd: 0.069,
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
    expect(jev).toHaveLength(35)
    expect(JSON.parse(jev[0]?.response ?? "{}")).toHaveProperty("answers")
    expect(kept.calls.filter((call) => call.kind === "embedding")).toHaveLength(
      34,
    )
  })

  it("scores a new threshold again from the kept calls, with no model call", async () => {
    const before = { ...requests }
    const recorded = await readRun(join(folder, "live"))
    const rescored = await run("rescore", {
      settings: { keepAt: 0.95 },
      capUsd: 0,
      kept: live,
      replay: recorded.calls,
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
})
