import { describe, expect, it } from "vitest"

import {
  type CheckValues,
  isBotComment,
  isHeadingOnly,
  regressionChecks,
} from "../../evals/knowledge/checks.js"
import { datasetSchema, type Question } from "../../evals/knowledge/dataset.js"
import { buildReport, renderMarkdown } from "../../evals/knowledge/report.js"
import type { Arm, ArmAnswer, Manifest } from "../../evals/knowledge/runner.js"
import { searchKnowledgePage } from "../mcp/tools/search-knowledge.js"
import type { KnowledgeHit } from "./knowledge-reader.js"

/*
 * The regression checks of CTX-1518. Each check gets a small result with the
 * defect, which it must show, and the same result without the defect, which
 * it must pass. The pages come from the page function of `search_knowledge`,
 * as in a run.
 */

const workspace = {
  id: "ws_eval",
  slug: "eval",
  served: { branch: "main", sha: "a".repeat(40) },
}

/** A search hit. `text` is the chunk text: the context line, then the section. */
const hit = (path: string, text: string, title: string | null = null) =>
  ({
    workspaceId: workspace.id,
    unitId: path,
    path,
    kind: null,
    title,
    source: path.split("/")[0] ?? "authored",
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    projectionSha: workspace.served.sha,
    startLine: 1,
    endLine: 3,
    text,
    claims: [],
    score: 0.5,
  }) satisfies KnowledgeHit

const pageOf = (hits: KnowledgeHit[]) => {
  const { page } = searchKnowledgePage({
    hits,
    workspaces: [workspace],
    skipped: [],
    offset: 0,
    limit: 8,
  })
  return page
}

const question = (id: string, change: Partial<Question> = {}): Question => ({
  id,
  corpus: "kubernetes",
  category: "lookup",
  split: "dev",
  text: `Question ${id}?`,
  gold: [`docs/${id}.md`],
  keyFacts: ["a fact"],
  ...change,
})

const answer = (
  arm: Arm,
  id: string,
  search: {
    refs?: string[]
    scores?: number[]
    hits?: KnowledgeHit[]
    latencyMs?: number
    quietMs?: number
  },
  related?: { refs: string[]; latencyMs?: number; quietMs?: number },
): ArmAnswer => {
  const refs = search.refs ?? search.hits?.map((one) => one.path) ?? []
  return {
    arm,
    question: id,
    search: {
      refs,
      scores: search.scores ?? refs.map(() => 0.5),
      latencyMs: search.latencyMs ?? 50,
      ...(search.quietMs === undefined ? {} : { quietMs: search.quietMs }),
      ...(search.hits ? { page: pageOf(search.hits) } : {}),
    },
    ...(related
      ? {
          related: {
            refs: related.refs,
            scores: related.refs.map(() => 0.5),
            latencyMs: related.latencyMs ?? 50,
            ...(related.quietMs === undefined
              ? {}
              : { quietMs: related.quietMs }),
          },
        }
      : {}),
    calls: {
      jev: 0,
      jevQuestions: 0,
      embedding: 1,
      costUsd: 0,
      missing: 0,
      failed: 0,
      unrecorded: 0,
      hedged: 0,
    },
  }
}

/** The checks of the legacy arm for `answers` of `questions`. */
const checksOf = (questions: Question[], answers: ArmAnswer[]): CheckValues =>
  regressionChecks({
    questions: new Map(questions.map((one) => [one.id, one])),
    answers,
    scored: answers,
  }).legacy

describe("the regression checks", () => {
  it("1: counts a second copy of one mirror item on the first page", () => {
    const issue = "CTX-77: Claude plugin distribution"
    // The readable part of the name differs from one copy to the next; the
    // provider id after `--` is the same.
    const copies = [
      hit("linear/teams/CTX/issues/ctx-77--u1.md", `${issue}\n\nText.`, issue),
      hit(
        "linear/projects/p1/issues/claude-plugin-distribution--u1.md",
        `${issue}\n\nText.`,
        issue,
      ),
      hit("knowledge/plugins.md", "Plugins\n\nText.", "Plugins"),
      hit("linear/issues/ctx-77--u1.md", `${issue}\n\nText.`, issue),
    ]
    const q = question("plugin")
    expect(
      checksOf([q], [answer("legacy", q.id, { hits: copies })]).duplicateSlots,
    ).toBe(2 / 4)
    // One copy of each item. Two GitHub issues with the same number in two
    // repositories are two items, and so are two items with the same title.
    const flake = "[Failing Test] scheduler"
    const distinct = [
      copies[0] as KnowledgeHit,
      copies[2] as KnowledgeHit,
      hit("github/issues/kubernetes/kubernetes/7.md", `${flake}\n\nA.`, flake),
      hit("github/issues/kubernetes/website/7.md", `${flake}\n\nB.`, flake),
      hit("github/issues/kubernetes/kubernetes/8.md", `${flake}\n\nC.`, flake),
      hit("linear/teams/CTX/issues/ctx-78--u2.md", `${issue}\n\nText.`, issue),
    ]
    expect(
      checksOf([q], [answer("legacy", q.id, { hits: distinct })])
        .duplicateSlots,
    ).toBe(0)
  })

  it("2: counts a first-page hit whose snippet holds only headings", () => {
    const title = "Plan"
    const empty = hit("docs/plan.md", "Plan > Phase 4\n\n## Phase 4", title)
    const full = hit(
      "docs/plan.md",
      "Plan > Phase 4\n\n## Phase 4\n\nRun the evals on each pull request.",
      title,
    )
    expect(isHeadingOnly(empty.text)).toBe(true)
    expect(isHeadingOnly("# Plan")).toBe(true)
    expect(isHeadingOnly(full.text)).toBe(false)
    // A context line with no blank line after it is section text.
    expect(isHeadingOnly("Some text")).toBe(false)
    const q = question("plan")
    expect(
      checksOf([q], [answer("legacy", q.id, { hits: [empty, full] })])
        .headingOnlyHits,
    ).toBe(1)
    expect(
      checksOf([q], [answer("legacy", q.id, { hits: [full] })]).headingOnlyHits,
    ).toBe(0)
  })

  it("3: gives the share of GitHub hits whose best chunk is a bot comment", () => {
    const title = "Flaky test in the scheduler"
    const bot = hit(
      "github/issues/kubernetes/kubernetes/1.md",
      `${title} > Comments > 2026-01-02T00:00:00Z · k8s-ci-robot[bot] (bot)\n\n### 2026-01-02T00:00:00Z · k8s-ci-robot[bot] (bot)\n\nThe tests failed.`,
      title,
    )
    const review = hit(
      "github/pulls/kubernetes/kubernetes/2--9.md",
      `${title} > Reviews > dependabot[bot] (bot) — APPROVED\n\nApproved.`,
      title,
    )
    const human = hit(
      "github/issues/kubernetes/kubernetes/3.md",
      `${title} > Comments > 2026-01-02T00:00:00Z · alice\n\nThe lock order is wrong.`,
      title,
    )
    const body = hit(
      "github/issues/kubernetes/kubernetes/4.md",
      `${title}\n\n# ${title}\n\nThe scheduler test fails one time in ten.`,
      title,
    )
    expect(isBotComment(bot.text)).toBe(true)
    expect(isBotComment(review.text)).toBe(true)
    expect(isBotComment(human.text)).toBe(false)
    const q = question("flaky")
    expect(
      checksOf(
        [q],
        [
          answer("legacy", q.id, {
            hits: [bot, review, human, body, hit("docs/a.md", "A\n\nText.")],
          }),
        ],
      ).botBestChunk,
    ).toBe(2 / 4)
    expect(
      checksOf([q], [answer("legacy", q.id, { hits: [human, body] })])
        .botBestChunk,
    ).toBe(0)
    // No GitHub hit: the check has no input.
    expect(
      checksOf([q], [answer("legacy", q.id, { hits: [] })]).botBestChunk,
    ).toBeNull()
  })

  it("4: gives the share of get_related slots that hold a high-degree unit with no gold label", () => {
    const hub = "knowledge/decisions/adr-024.md"
    const questions = ["a", "b", "c"].map((id) =>
      question(id, {
        seeds: [`seeds/${id}.md`],
        gold: id === "a" ? ["docs/a.md", hub] : [`docs/${id}.md`],
      }),
    )
    const related = (one: Question, hubs: string[]) => ({
      ...answer("legacy", one.id, { refs: [] }),
      related: {
        refs: [`seeds/${one.id}.md`, `docs/${one.id}.md`, hub],
        scores: [0.5, 0.5, 0.5],
        latencyMs: 50,
        hubs,
      },
    })
    // The run marks the hub as a high-degree unit of the corpus. It is gold
    // only for `a`, so its slot of `a` does not count. The seed of a
    // question is not a slot: 6 slots.
    expect(
      checksOf(
        questions,
        questions.map((one) => related(one, [hub])),
      ).hubSlots,
    ).toBe(2 / 6)
    expect(
      checksOf(
        questions,
        questions.map((one) => related(one, [])),
      ).hubSlots,
    ).toBe(0)
    // The seeds take no slot of the 10: the 11th result counts.
    const many = question("many", { seeds: ["seeds/many.md"] })
    expect(
      checksOf(
        [many],
        [
          {
            ...answer("legacy", many.id, { refs: [] }),
            related: {
              refs: [
                "seeds/many.md",
                ...Array.from({ length: 9 }, (_, index) => `docs/r${index}.md`),
                hub,
              ],
              scores: Array.from({ length: 11 }, () => 0.5),
              latencyMs: 50,
              hubs: [hub],
            },
          },
        ],
      ).hubSlots,
    ).toBe(1 / 10)
    // A run from before the hubs were marked has no value.
    expect(
      checksOf(questions, [
        answer("legacy", "a", { refs: [] }, { refs: ["docs/a.md"] }),
      ]).hubSlots,
    ).toBeNull()
  })

  it("5: needs a live document before each stale copy", () => {
    const q = question("retired", {
      gold: ["docs/live.md"],
      stale: ["docs/archive/old.md"],
    })
    expect(
      checksOf(
        [q],
        [
          answer("legacy", q.id, {
            refs: ["docs/archive/old.md", "docs/live.md"],
          }),
        ],
      ).liveFirst,
    ).toBe(0)
    expect(
      checksOf(
        [q],
        [
          answer("legacy", q.id, {
            refs: ["docs/live.md", "docs/archive/old.md"],
          }),
        ],
      ).liveFirst,
    ).toBe(1)
    // No stale label: the check has no input.
    const plain = question("plain")
    expect(
      checksOf(
        [plain],
        [answer("legacy", plain.id, { refs: ["docs/plain.md"] })],
      ).liveFirst,
    ).toBeNull()
  })

  it("6: separates the top score of a true hit from the top score of a no-answer question", () => {
    const answered = question("answered")
    const none = question("none", {
      category: "no-answer",
      gold: [],
      keyFacts: [],
    })
    const questions = [answered, none]
    // Today: the no-answer question gets the same score as a true hit.
    expect(
      checksOf(questions, [
        answer("legacy", answered.id, {
          refs: ["docs/answered.md"],
          scores: [0.03],
        }),
        answer("legacy", none.id, { refs: ["docs/other.md"], scores: [0.03] }),
      ]).noAnswerSeparation,
    ).toBe(0.5)
    expect(
      checksOf(questions, [
        answer("legacy", answered.id, {
          refs: ["docs/answered.md"],
          scores: [0.9],
        }),
        answer("legacy", none.id, { refs: ["docs/other.md"], scores: [0.1] }),
      ]).noAnswerSeparation,
    ).toBe(1)
    // A search with no hit is the weakest result.
    expect(
      checksOf(questions, [
        answer("legacy", answered.id, {
          refs: ["docs/answered.md"],
          scores: [0.01],
        }),
        answer("legacy", none.id, { refs: [] }),
      ]).noAnswerSeparation,
    ).toBe(1)
  })

  it("7: reports the first calls after the quiet time, which the warm p95 hides", () => {
    const questions = Array.from({ length: 20 }, (_, index) =>
      question(`q${index}`, { seeds: ["seeds/s.md"] }),
    )
    // The run waits a quiet time before the first call of each kind.
    const run = (firstMs: number) =>
      questions.map((one, index) => {
        const first = index === 0 ? { quietMs: 31_000 } : {}
        return answer(
          "legacy",
          one.id,
          { refs: [], latencyMs: index === 0 ? firstMs : 50, ...first },
          { refs: [], latencyMs: index === 0 ? firstMs : 60, ...first },
        )
      })
    const cold = checksOf(questions, run(40_000))
    expect(cold.coldSearchMs).toBe(40_000)
    expect(cold.coldRelatedMs).toBe(40_000)
    const report = buildReport({
      manifest: manifest("live"),
      dataset: datasetOf(questions),
      answers: run(40_000).flatMap((one) => [
        one,
        { ...one, arm: "plane" as const },
      ]),
      kept: null,
    })
    // The nearest-rank p95 of 20 calls is the 19th: a warm call.
    expect(report.operations[0]?.searchP95Ms).toBe(50)
    expect(report.checks.legacy.coldSearchMs).toBe(40_000)
    expect(checksOf(questions, run(55)).coldSearchMs).toBe(55)
    // A run from before the quiet time has no cold call.
    const old = questions.map((one) =>
      answer("legacy", one.id, { refs: [] }, { refs: [] }),
    )
    expect(checksOf(questions, old).coldSearchMs).toBeNull()
    expect(checksOf(questions, old).coldRelatedMs).toBeNull()
  })

  it("8: gives the bytes of the first page that a client gets", () => {
    const q = question("size")
    const long = "The scheduler places each pod on a node. ".repeat(40)
    const hits = (text: string) =>
      Array.from({ length: 8 }, (_, index) =>
        hit(
          `docs/page-${index}.md`,
          `Page ${index}\n\n${text}`,
          `Page ${index}`,
        ),
      )
    const large = checksOf([q], [answer("legacy", q.id, { hits: hits(long) })])
    // The snippets of the tool are at most 600 characters, so eight long
    // chunks give a page of about 6 KB.
    expect(large.pageBytes).toBeGreaterThan(5_000)
    const compact = checksOf(
      [q],
      [answer("legacy", q.id, { hits: hits("One short line.") })],
    )
    expect(compact.pageBytes).toBeLessThan(3_000)
    expect(compact.pageBytes).toBeGreaterThan(0)
  })

  it("gives no value for the page checks to a run from before the page was kept", () => {
    const q = question("old")
    const values = checksOf(
      [q],
      [answer("legacy", q.id, { refs: ["docs/old.md"] })],
    )
    expect(values.duplicateSlots).toBeNull()
    expect(values.headingOnlyHits).toBeNull()
    expect(values.botBestChunk).toBeNull()
    expect(values.pageBytes).toBeNull()
  })
})

const manifest = (mode: Manifest["mode"]): Manifest => ({
  datasetVersion: "0",
  splits: ["dev"],
  now: "2026-11-22T00:00:00.000Z",
  settings: {},
  loop: { keepAt: 0.5 },
  mode,
  capUsd: 5,
  spentUsd: 0,
  stopped: false,
  quietMs: 31_000,
})

const datasetOf = (questions: Question[]) =>
  datasetSchema.parse({
    version: "0",
    corpora: [...new Set(questions.map((one) => one.corpus))].map((id) => ({
      id,
      source: `example/${id}`,
      contextRepo: {
        url: "https://example.com/context.git",
        sha: "b".repeat(40),
      },
      workspace: id,
    })),
    questions,
  })

describe("the stale label and the report", () => {
  it("refuses a stale document that is gold, and a stale label on a no-answer question", () => {
    const check = (change: Partial<Question>) =>
      datasetSchema
        .safeParse({
          ...datasetOf([question("x")]),
          questions: [question("x", change)],
        })
        .error?.issues.map((issue) => issue.message)
    expect(check({ stale: ["docs/x.md"] })).toEqual([
      "Question x: stale ref docs/x.md is gold.",
    ])
    expect(
      check({
        category: "no-answer",
        gold: [],
        keyFacts: [],
        stale: ["docs/old.md"],
      }),
    ).toEqual(["Question x: a no-answer question has no stale distractor."])
    expect(check({ stale: ["docs/old.md"] })).toBeUndefined()
  })

  it("shows each check for both arms, and says what a replay measures", () => {
    const q = question("both")
    const answers = (["legacy", "plane"] as const).map((arm) =>
      answer(arm, q.id, {
        hits: [hit("docs/both.md", "Both\n\nText.", "Both")],
        quietMs: 31_000,
      }),
    )
    const live = renderMarkdown(
      buildReport({
        manifest: manifest("live"),
        dataset: datasetOf([q]),
        answers,
        kept: null,
      }),
    )
    const section = live.slice(
      live.indexOf("## Regression checks"),
      live.indexOf("## Operations"),
    )
    expect(section).toContain(
      "| 1. second copies of an item on the first page (share of slots) | lower | 0.000 | 0.000 |",
    )
    expect(section).toContain(
      "| 7. cold first search | lower | 50 ms | 50 ms |",
    )
    expect(section.match(/^\| [1-8]\. /gm)).toHaveLength(9)
    expect(section).toContain(
      "Check 7: the run waited 31000 ms with no call before the first search and the first get_related of each arm.",
    )
    expect(section).not.toContain("replay")
    const replay = renderMarkdown(
      buildReport({
        manifest: manifest("replay"),
        dataset: datasetOf([q]),
        answers,
        kept: null,
      }),
    )
    expect(replay).toContain(
      "A replay answers each model call at once, so check 7 holds only the time of the stores.",
    )
  })
})
