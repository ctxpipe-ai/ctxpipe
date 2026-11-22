import { z } from "zod"

import { CATEGORIES, type Dataset, type Question } from "./dataset.js"
import {
  meanMetrics,
  METRIC_NAMES,
  METRICS,
  type MetricValues,
  operations,
  overBudget,
  type QuestionScore,
  scoreAnswer,
} from "./metrics.js"
import {
  ARM_NAMES,
  ARMS,
  type Arm,
  type ArmAnswer,
  type Manifest,
} from "./runner.js"

/*
 * The report of one run: JSON for tools, Markdown for people. The first
 * table compares the plane with the baseline arm, the current stack, for
 * each split and category (a CTO requirement). The kept run is the report
 * of the last run that the improvement loop kept (ADR-069 decision 7). The
 * report compares the plane with it for each split and category, and its
 * guards, for the keep-or-revert rule: a change stays only if the hold-out
 * set improves and no guard gets worse. Each question also gets its change
 * against the kept run.
 */

type Change = "better" | "worse" | "mixed" | "same" | "new"

type ComparisonRow = {
  split: Question["split"]
  category: Question["category"] | "all"
  questions: number
  /** The mean of each metric on the baseline arm. */
  baseline: MetricValues
  plane: MetricValues
  /** The plane value minus the baseline value. */
  change: MetricValues
}

/** The plane against the kept run, for one split and category. */
type KeptRow = {
  split: Question["split"]
  category: Question["category"] | "all"
  questions: number
  kept: MetricValues
  now: MetricValues
  /** The value now minus the kept value. */
  change: MetricValues
}

/** The guards of the plane against the kept run, for one split. */
type KeptGuardRow = {
  split: Question["split"]
  questions: number
  kept: Guards
  now: Guards
}

/**
 * The guards of ADR-069 decision 6 that the keep-or-revert rule reads. A
 * latency is null in a replay.
 */
type Guards = Pick<
  ReturnType<typeof operations>,
  | "searchP95Ms"
  | "relatedP95Ms"
  | "jevCallsPerQuestion"
  | "jevQuestionsPerQuestion"
  | "errors"
> & { costPerQuestionUsd: number }

export type Report = {
  datasetVersion: string
  /**
   * `spend-cap`: the spend cap stopped the run before its last question.
   * `errors`: an answer has a failed call (see `errors`). A metric of such a
   * run can be 0 only because a call failed.
   */
  status: "complete" | "errors" | "spend-cap"
  /**
   * The scored answers with an error (`QuestionScore.error`), of each arm.
   * An answer that a replay could not complete is in `incomplete`, not here.
   */
  errors: number
  arms: { baseline: string; plane: string }
  run: Omit<Manifest, "datasetVersion">
  comparison: ComparisonRow[]
  operations: ({ arm: Arm; split: Question["split"] } & ReturnType<
    typeof operations
  >)[]
  /** The cost of the model calls. In a replay, their cost when they were made. */
  costUsd: number
  questions: (QuestionScore & { kept: MetricValues | null; change: Change })[]
  /**
   * The plane against the kept run, on the questions that both runs scored.
   * Null when there is no kept run.
   */
  kept: { comparison: KeptRow[]; guards: KeptGuardRow[] } | null
  /**
   * The questions that the report leaves out, because an arm has no complete
   * answer: the spend cap stopped the run, or a replay missed a call.
   */
  incomplete: string[]
}

/** The part of a kept report that a new report compares with. */
export const keptRunSchema = z.object({
  run: z.object({ mode: z.enum(["live", "replay"]) }),
  questions: z.array(
    z.object({
      arm: z.enum(ARMS),
      question: z.string(),
      metrics: z.record(z.enum(METRICS), z.number().nullable()),
      searchMs: z.number(),
      relatedMs: z.number().nullable(),
      jevCalls: z.number(),
      jevQuestions: z.number(),
      costUsd: z.number(),
      error: z.string().optional(),
    }),
  ),
})
export type KeptRun = z.infer<typeof keptRunSchema>

/** The change of `value` against `base` for each metric. */
function delta(value: MetricValues, base: MetricValues): MetricValues {
  const result = {} as MetricValues
  for (const metric of METRICS) {
    const a = value[metric]
    const b = base[metric]
    result[metric] = a === null || b === null ? null : a - b
  }
  return result
}

function changeOf(now: MetricValues, kept: MetricValues | null): Change {
  if (!kept) return "new"
  const moves = Object.values(delta(now, kept)).filter(
    (value): value is number => value !== null && Math.abs(value) > 1e-9,
  )
  const up = moves.some((value) => value > 0)
  const down = moves.some((value) => value < 0)
  return up && down ? "mixed" : up ? "better" : down ? "worse" : "same"
}

/**
 * Score the answers of a run and build its report. Only the questions with
 * a complete answer from both arms count, so that both arms are compared on
 * the same questions. `kept` is the kept run, or null when there is none.
 */
export function buildReport(input: {
  manifest: Manifest
  dataset: Dataset
  answers: readonly ArmAnswer[]
  kept: KeptRun | null
}): Report {
  const { manifest } = input
  const complete = (id: string) =>
    ARMS.every((arm) =>
      input.answers.some(
        (answer) =>
          answer.arm === arm &&
          answer.question === id &&
          answer.calls.missing === 0,
      ),
    )
  const asked = input.dataset.questions.filter((question) =>
    input.answers.some((answer) => answer.question === question.id),
  )
  const scores = asked
    .filter((question) => complete(question.id))
    .flatMap((question) =>
      input.answers
        .filter((answer) => answer.question === question.id)
        .map((answer) => scoreAnswer(question, answer, manifest.loop.keepAt)),
    )
  const keptScores = new Map(
    (input.kept?.questions ?? []).map((score) => [
      `${score.arm}\0${score.question}`,
      score.metrics as MetricValues,
    ]),
  )
  const comparison: ComparisonRow[] = []
  for (const split of manifest.splits)
    for (const category of ["all" as const, ...CATEGORIES]) {
      const group = scores.filter(
        (score) =>
          score.split === split &&
          (category === "all" || score.category === category),
      )
      if (group.length === 0) continue
      const of = (arm: Arm) =>
        meanMetrics(group.filter((score) => score.arm === arm))
      const baseline = of("legacy")
      const plane = of("plane")
      comparison.push({
        split,
        category,
        questions: new Set(group.map((score) => score.question)).size,
        baseline,
        plane,
        change: delta(plane, baseline),
      })
    }
  const { datasetVersion, ...run } = manifest
  const errors = scores.filter((score) => score.error).length
  return {
    datasetVersion,
    status: manifest.stopped ? "spend-cap" : errors ? "errors" : "complete",
    errors,
    arms: { baseline: ARM_NAMES.legacy, plane: ARM_NAMES.plane },
    run,
    comparison,
    operations: ARMS.flatMap((arm) =>
      manifest.splits.flatMap((split) => {
        const group = scores.filter(
          (score) => score.arm === arm && score.split === split,
        )
        return group.length
          ? [
              {
                arm,
                split,
                ...operations(
                  group,
                  manifest.mode === "live",
                  manifest.productBudgetMs ?? null,
                ),
              },
            ]
          : []
      }),
    ),
    // A live run spends also on the answer that the cap stopped.
    costUsd:
      manifest.mode === "live"
        ? manifest.spentUsd
        : input.answers.reduce((sum, answer) => sum + answer.calls.costUsd, 0),
    questions: scores.map((score) => {
      const kept = keptScores.get(`${score.arm}\0${score.question}`) ?? null
      return { ...score, kept, change: changeOf(score.metrics, kept) }
    }),
    incomplete: asked
      .filter((question) => !complete(question.id))
      .map((question) => question.id),
    kept: input.kept
      ? compareWithKept({
          now: scores,
          kept: input.kept,
          splits: manifest.splits,
          measured: manifest.mode === "live",
        })
      : null,
  }
}

/**
 * The plane against the kept run, for each split and category, and its
 * guards for each split. Both sides read only the questions that both runs
 * scored, so a question that one run left out moves no mean.
 */
function compareWithKept(input: {
  now: readonly QuestionScore[]
  kept: KeptRun
  splits: Manifest["splits"]
  measured: boolean
}): NonNullable<Report["kept"]> {
  const planeScores = new Map(
    input.now
      .filter((score) => score.arm === "plane")
      .map((score) => [score.question, score]),
  )
  const pairs = input.kept.questions.flatMap((kept) => {
    const score =
      kept.arm === "plane" ? planeScores.get(kept.question) : undefined
    if (!score) return []
    // The split and the category are those of the dataset of this run. The
    // guards do not read the embedding calls and the partial answers.
    const keptScore: QuestionScore = {
      ...kept,
      arm: "plane",
      split: score.split,
      category: score.category,
      embeddingCalls: 0,
      partial: false,
    }
    return [{ now: score, kept: keptScore }]
  })
  const guards = (
    scores: readonly QuestionScore[],
    measured: boolean,
  ): Guards => {
    const row = operations(scores, measured)
    return {
      searchP95Ms: row.searchP95Ms,
      relatedP95Ms: row.relatedP95Ms,
      jevCallsPerQuestion: row.jevCallsPerQuestion,
      jevQuestionsPerQuestion: row.jevQuestionsPerQuestion,
      costPerQuestionUsd: row.questions ? row.costUsd / row.questions : 0,
      errors: row.errors,
    }
  }
  const comparison: KeptRow[] = []
  const guardRows: KeptGuardRow[] = []
  for (const split of input.splits) {
    for (const category of ["all" as const, ...CATEGORIES]) {
      const group = pairs.filter(
        (pair) =>
          pair.now.split === split &&
          (category === "all" || pair.now.category === category),
      )
      if (group.length === 0) continue
      const kept = meanMetrics(group.map((pair) => pair.kept))
      const nowMetrics = meanMetrics(group.map((pair) => pair.now))
      comparison.push({
        split,
        category,
        questions: group.length,
        kept,
        now: nowMetrics,
        change: delta(nowMetrics, kept),
      })
    }
    const group = pairs.filter((pair) => pair.now.split === split)
    if (group.length)
      guardRows.push({
        split,
        questions: group.length,
        kept: guards(
          group.map((pair) => pair.kept),
          input.kept.run.mode === "live",
        ),
        now: guards(
          group.map((pair) => pair.now),
          input.measured,
        ),
      })
  }
  return { comparison, guards: guardRows }
}

const value = (number: number | null) =>
  number === null ? "n/a" : number.toFixed(3)
const signed = (number: number | null) =>
  number === null ? "n/a" : `${number >= 0 ? "+" : ""}${number.toFixed(3)}`
const ms = (number: number | null) =>
  number === null ? "n/a" : `${Math.round(number)} ms`
const usd = (number: number) => `$${number.toFixed(4)}`

/** The Markdown of a report. */
export function renderMarkdown(report: Report): string {
  const lines = [
    "# Knowledge eval report",
    "",
    `Status: ${report.status}. Dataset ${report.datasetVersion}. Mode: ${report.run.mode}. Query time: ${report.run.now}.`,
    `Settings: ${JSON.stringify(report.run.settings)}. Spend: ${usd(report.run.spentUsd)} of ${usd(report.run.capUsd)}.`,
    ...(report.run.stopped
      ? [
          "",
          "**The spend cap stopped the run. The report holds only the questions that both arms answered before the stop.**",
        ]
      : []),
    ...(report.errors
      ? [
          "",
          `**${report.errors} answers have a failed call (see "Errors"). Do not use the metrics of this run: a failed call gives a score of 0.**`,
        ]
      : []),
    "",
    `## Comparison with the ${report.arms.baseline}`,
    "",
    "Both arms ran the same questions on the same Workspaces, at the same SHA, with the same requests and budgets. The change is the plane value minus the baseline value.",
    "",
    `| Split | Category | Questions | Metric | Baseline | ${report.arms.plane} | Change |`,
    "| --- | --- | ---: | --- | ---: | ---: | ---: |",
  ]
  for (const row of report.comparison)
    for (const metric of METRICS) {
      if (row.baseline[metric] === null && row.plane[metric] === null) continue
      lines.push(
        `| ${row.split} | ${row.category} | ${row.questions} | ${METRIC_NAMES[metric]} | ${value(row.baseline[metric])} | ${value(row.plane[metric])} | ${signed(row.change[metric])} |`,
      )
    }
  lines.push(
    "",
    "## Operations",
    "",
    ...(report.run.mode === "replay"
      ? [
          "A replay answers each model call at once, so it gives no latency.",
          "",
        ]
      : []),
    `Time budget of the run: ${report.run.loop.timeBudgetMs ? ms(report.run.loop.timeBudgetMs) : "none"}. Over the product budget: the answers with a call that took longer than ${ms(report.run.productBudgetMs ?? null)}.`,
    "",
    "| Arm | Split | Questions | Search p50 | Search p95 | get_related p50 | get_related p95 | Jev calls / question | Jev questions / question | Embedding calls / question | Cost | Errors | Partial | Over the product budget |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.operations.map(
      (row) =>
        `| ${row.arm} | ${row.split} | ${row.questions} | ${ms(row.searchP50Ms)} | ${ms(row.searchP95Ms)} | ${ms(row.relatedP50Ms)} | ${ms(row.relatedP95Ms)} | ${row.jevCallsPerQuestion.toFixed(1)} | ${row.jevQuestionsPerQuestion.toFixed(1)} | ${row.embeddingCallsPerQuestion.toFixed(1)} | ${usd(row.costUsd)} | ${row.errors} | ${row.partial} | ${row.overProductBudget ?? "n/a"} |`,
    ),
    "",
    `Model cost: ${usd(report.costUsd)}${report.run.mode === "replay" ? " (the cost of the recorded calls when they were made)" : ""}.`,
    "",
  )
  if (report.kept?.comparison.length === 0)
    lines.push(
      "## The plane against the kept run",
      "",
      "No question was scored by both runs.",
      "",
    )
  else if (report.kept) {
    lines.push(
      "## The plane against the kept run",
      "",
      "The keep-or-revert rule of ADR-069 decision 7: the change stays only if the hold-out set improves and no guard gets worse. Both columns read only the questions that both runs scored.",
      "",
      "| Split | Category | Questions | Metric | Kept | Now | Change |",
      "| --- | --- | ---: | --- | ---: | ---: | ---: |",
    )
    for (const row of report.kept.comparison)
      for (const metric of METRICS) {
        if (row.kept[metric] === null && row.now[metric] === null) continue
        lines.push(
          `| ${row.split} | ${row.category} | ${row.questions} | ${METRIC_NAMES[metric]} | ${value(row.kept[metric])} | ${value(row.now[metric])} | ${signed(row.change[metric])} |`,
        )
      }
    lines.push(
      "",
      "Guards (a higher value is worse; a replay gives no latency):",
      "",
      "| Split | Questions | Guard | Kept | Now | Change |",
      "| --- | ---: | --- | ---: | ---: | ---: |",
    )
    for (const { split, questions, kept, now } of report.kept.guards) {
      const latency = (name: string, a: number | null, b: number | null) =>
        `| ${split} | ${questions} | ${name} | ${ms(a)} | ${ms(b)} | ${a === null || b === null ? "n/a" : `${b >= a ? "+" : "-"}${ms(Math.abs(b - a))}`} |`
      const number = (
        name: string,
        a: number,
        b: number,
        show: (n: number) => string,
      ) =>
        `| ${split} | ${questions} | ${name} | ${show(a)} | ${show(b)} | ${b === a ? "0" : `${b > a ? "+" : "-"}${show(Math.abs(b - a))}`} |`
      lines.push(
        latency("search p95", kept.searchP95Ms, now.searchP95Ms),
        latency("get_related p95", kept.relatedP95Ms, now.relatedP95Ms),
        number(
          "Jev calls / question",
          kept.jevCallsPerQuestion,
          now.jevCallsPerQuestion,
          (n) => n.toFixed(3),
        ),
        number(
          "Jev questions / question",
          kept.jevQuestionsPerQuestion,
          now.jevQuestionsPerQuestion,
          (n) => n.toFixed(3),
        ),
        number(
          "cost / question",
          kept.costPerQuestionUsd,
          now.costPerQuestionUsd,
          (n) => `$${n.toFixed(6)}`,
        ),
        number("errors", kept.errors, now.errors, String),
      )
    }
    lines.push("")
  }
  lines.push("## Changes against the kept run", "")
  const changed = report.questions.filter(
    (question) => question.change !== "same",
  )
  if (report.questions.every((question) => question.change === "new"))
    lines.push("There is no kept run to compare with.")
  else if (changed.length === 0) lines.push("No question changed.")
  else {
    lines.push(
      "| Question | Arm | Split | Change | Metrics now | Metrics kept |",
      "| --- | --- | --- | --- | --- | --- |",
    )
    const list = (metrics: MetricValues | null) =>
      metrics
        ? METRICS.filter((metric) => metrics[metric] !== null)
            .map(
              (metric) => `${METRIC_NAMES[metric]} ${value(metrics[metric])}`,
            )
            .join(", ")
        : "n/a"
    for (const question of changed)
      lines.push(
        `| ${question.question} | ${question.arm} | ${question.split} | ${question.change} | ${list(question.metrics)} | ${list(question.kept)} |`,
      )
  }
  const budget = report.run.productBudgetMs
  const slow =
    budget && report.run.mode === "live"
      ? report.questions.filter((question) => overBudget(question, budget))
      : []
  if (slow.length)
    lines.push(
      "",
      "## Answers over the product time budget",
      "",
      `These answers took longer than the ${ms(budget ?? null)} budget of the product. With that budget, they would be partial.`,
      "",
      ...slow.map((question) => {
        const parts = [
          ...(budget && question.searchMs > budget
            ? [`search ${ms(question.searchMs)}`]
            : []),
          ...(budget && (question.relatedMs ?? 0) > budget
            ? [`get_related ${ms(question.relatedMs)}`]
            : []),
        ]
        return `- ${question.question} (${question.arm}): ${parts.join(", ")}`
      }),
    )
  const failed = report.questions.filter((question) => question.error)
  if (failed.length)
    lines.push(
      "",
      "## Errors",
      "",
      ...failed.map(
        (question) =>
          `- ${question.question} (${question.arm}): ${question.error}`,
      ),
    )
  if (report.incomplete.length)
    lines.push(
      "",
      "## Questions left out",
      "",
      "An arm has no complete answer to these questions: the spend cap stopped the run, or the recording of a replay does not hold each model call. Run them live to score them.",
      "",
      ...report.incomplete.map((question) => `- ${question}`),
    )
  return `${lines.join("\n")}\n`
}
