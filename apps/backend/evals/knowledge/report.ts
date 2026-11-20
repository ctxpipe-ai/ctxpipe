import { z } from "zod"

import { ZDR_PROVIDER } from "../../src/retrieval/services/modelProvider.js"
import { CATEGORIES, type Dataset, type Question } from "./dataset.js"
import {
  meanMetrics,
  METRIC_NAMES,
  METRICS,
  type MetricValues,
  operations,
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
type Guards = {
  searchP95Ms: number | null
  relatedP95Ms: number | null
  jevCallsPerQuestion: number
  jevQuestionsPerQuestion: number
  costPerQuestionUsd: number
  errors: number
}

export type Report = {
  datasetVersion: string
  /** `spend-cap`: the spend cap stopped the run before its last question. */
  status: "complete" | "spend-cap"
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
      embeddingCalls: z.number(),
      costUsd: z.number(),
      error: z.string().optional(),
      partial: z.boolean(),
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
  return {
    datasetVersion,
    status: manifest.stopped ? "spend-cap" : "complete",
    arms: { baseline: ARM_NAMES.legacy, plane: ARM_NAMES.plane },
    run,
    comparison,
    operations: ARMS.flatMap((arm) =>
      manifest.splits.flatMap((split) => {
        const group = scores.filter(
          (score) => score.arm === arm && score.split === split,
        )
        return group.length
          ? [{ arm, split, ...operations(group, manifest.mode === "live") }]
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
  const now = new Map(
    input.now
      .filter((score) => score.arm === "plane")
      .map((score) => [score.question, score]),
  )
  const pairs = input.kept.questions.flatMap((kept) => {
    const score = kept.arm === "plane" ? now.get(kept.question) : undefined
    // The split and the category are those of the dataset of this run.
    return score
      ? [{ now: score, kept: { ...score, ...kept, arm: "plane" as const } }]
      : []
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
      const value = meanMetrics(group.map((pair) => pair.now))
      comparison.push({
        split,
        category,
        questions: group.length,
        kept,
        now: value,
        change: delta(value, kept),
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
const count = (number: number | null) =>
  number === null ? "n/a" : number.toFixed(1)

/** The Markdown of a report. */
export function renderMarkdown(report: Report): string {
  const lines = [
    "# Knowledge eval report",
    "",
    `Status: ${report.status}. Dataset ${report.datasetVersion}. Mode: ${report.run.mode}. Query time: ${report.run.now}.`,
    `Settings: ${JSON.stringify(report.run.settings)}. Spend: ${usd(report.run.spentUsd)} of ${usd(report.run.capUsd)}.`,
    ...(Object.keys(report.run.zdrAdded).length
      ? [
          "",
          `Run notes: the request did not set the ZDR fields, so the harness added the ZDR block \`${JSON.stringify(ZDR_PROVIDER)}\` (ADR-068 decision 7): ${Object.entries(
            report.run.zdrAdded,
          )
            .map(([call, count]) => `${call} (${count})`)
            .join(", ")}.`,
        ]
      : []),
    ...(report.run.stopped
      ? [
          "",
          "**The spend cap stopped the run. The report holds only the questions that both arms answered before the stop.**",
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
    "| Arm | Split | Questions | Search p50 | Search p95 | get_related p50 | get_related p95 | Jev calls / question | Jev questions / question | Embedding calls / question | Cost | Errors | Partial |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.operations.map(
      (row) =>
        `| ${row.arm} | ${row.split} | ${row.questions} | ${ms(row.searchP50Ms)} | ${ms(row.searchP95Ms)} | ${ms(row.relatedP50Ms)} | ${ms(row.relatedP95Ms)} | ${row.jevCallsPerQuestion.toFixed(1)} | ${row.jevQuestionsPerQuestion.toFixed(1)} | ${row.embeddingCallsPerQuestion.toFixed(1)} | ${usd(row.costUsd)} | ${row.errors} | ${row.partial} |`,
    ),
    "",
    `Model cost: ${usd(report.costUsd)}${report.run.mode === "replay" ? " (the cost of the recorded calls when they were made)" : ""}.`,
    "",
  )
  if (report.kept) {
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
    const guardNames: [
      keyof Guards,
      string,
      (number: number | null) => string,
    ][] = [
      ["searchP95Ms", "search p95", ms],
      ["relatedP95Ms", "get_related p95", ms],
      ["jevCallsPerQuestion", "Jev calls / question", count],
      ["jevQuestionsPerQuestion", "Jev questions / question", count],
      [
        "costPerQuestionUsd",
        "cost / question",
        (number) => (number === null ? "n/a" : usd(number)),
      ],
      [
        "errors",
        "errors",
        (number) => (number === null ? "n/a" : String(number)),
      ],
    ]
    lines.push(
      "",
      "Guards (a higher value is worse; a replay gives no latency):",
      "",
      "| Split | Questions | Guard | Kept | Now | Change |",
      "| --- | ---: | --- | ---: | ---: | ---: |",
    )
    for (const row of report.kept.guards)
      for (const [key, name, format] of guardNames) {
        const kept = row.kept[key]
        const now = row.now[key]
        const change =
          kept === null || now === null
            ? "n/a"
            : `${now - kept >= 0 ? "+" : "-"}${format(Math.abs(now - kept))}`
        lines.push(
          `| ${row.split} | ${row.questions} | ${name} | ${format(kept)} | ${format(now)} | ${change} |`,
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
