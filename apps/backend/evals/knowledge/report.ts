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
import { ARM_NAMES, type Arm, type ArmAnswer, type Manifest } from "./runner.js"

/*
 * The report of one run: JSON for tools, Markdown for people. The first
 * table compares each arm with the baseline arm, the current stack, for each
 * split and category (a CTO requirement). Each question also gets its change
 * against the kept run: the report of the last run that the improvement loop
 * kept (ADR-069 decision 7).
 */

const BASELINE: Arm = "legacy"

type Change = "better" | "worse" | "mixed" | "same" | "new"

type ComparisonRow = {
  split: Question["split"]
  category: Question["category"] | "all"
  questions: number
  /** The mean of each metric for each arm. */
  arms: Partial<Record<Arm, MetricValues>>
  /** The change of each other arm against the baseline arm. */
  change: Partial<Record<Arm, MetricValues>>
}

export type Report = {
  datasetVersion: string
  baselineArm: { id: Arm; name: string }
  arms: { id: Arm; name: string }[]
  run: Omit<Manifest, "datasetVersion" | "arms">
  comparison: ComparisonRow[]
  operations: ({ arm: Arm; split: Question["split"] } & ReturnType<
    typeof operations
  >)[]
  cost: { totalUsd: number; byArm: Partial<Record<Arm, number>> }
  questions: (QuestionScore & { kept: MetricValues | null; change: Change })[]
  /** Replay only: answers that the recording could not give in full. */
  incomplete: { arm: Arm; question: string }[]
}

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
 * Score the answers of a run and build its report. `kept` is the report of
 * the kept run, or null when there is none yet.
 */
export function buildReport(input: {
  manifest: Manifest
  dataset: Dataset
  answers: readonly ArmAnswer[]
  kept: Report | null
}): Report {
  const { manifest } = input
  const questions = new Map(input.dataset.questions.map((q) => [q.id, q]))
  const complete = input.answers.filter((answer) => !answer.incomplete)
  const scores = complete.flatMap((answer) => {
    const question = questions.get(answer.question)
    return question ? [scoreAnswer(question, answer, manifest.loop.keepAt)] : []
  })
  const keptScores = new Map(
    (input.kept?.questions ?? []).map((score) => [
      `${score.arm}\0${score.question}`,
      score.metrics,
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
      const arms: ComparisonRow["arms"] = {}
      for (const arm of manifest.arms)
        arms[arm] = meanMetrics(group.filter((score) => score.arm === arm))
      const base = arms[BASELINE]
      const change: ComparisonRow["change"] = {}
      for (const arm of manifest.arms) {
        const values = arms[arm]
        if (arm !== BASELINE && base && values)
          change[arm] = delta(values, base)
      }
      comparison.push({
        split,
        category,
        questions: new Set(group.map((score) => score.question)).size,
        arms,
        change,
      })
    }
  const byArm: Report["cost"]["byArm"] = {}
  for (const arm of manifest.arms)
    byArm[arm] = scores
      .filter((score) => score.arm === arm)
      .reduce((sum, score) => sum + score.costUsd, 0)
  const { datasetVersion: _version, arms: _arms, ...run } = manifest
  return {
    datasetVersion: manifest.datasetVersion,
    baselineArm: { id: BASELINE, name: ARM_NAMES[BASELINE] },
    arms: manifest.arms.map((id) => ({ id, name: ARM_NAMES[id] })),
    run,
    comparison,
    operations: manifest.arms.flatMap((arm) =>
      manifest.splits.flatMap((split) => {
        const group = scores.filter(
          (score) => score.arm === arm && score.split === split,
        )
        return group.length ? [{ arm, split, ...operations(group) }] : []
      }),
    ),
    cost: {
      totalUsd: input.answers.reduce(
        (sum, answer) => sum + answer.calls.costUsd,
        0,
      ),
      byArm,
    },
    questions: scores.map((score) => {
      const kept = keptScores.get(`${score.arm}\0${score.question}`) ?? null
      return { ...score, kept, change: changeOf(score.metrics, kept) }
    }),
    incomplete: input.answers
      .filter((answer) => answer.incomplete)
      .map(({ arm, question }) => ({ arm, question })),
  }
}

const value = (number: number | null) =>
  number === null ? "n/a" : number.toFixed(3)
const signed = (number: number | null | undefined) =>
  number === null || number === undefined
    ? "n/a"
    : `${number >= 0 ? "+" : ""}${number.toFixed(3)}`
const ms = (number: number | null) =>
  number === null ? "n/a" : `${Math.round(number)} ms`
const usd = (number: number) => `$${number.toFixed(4)}`

/** The Markdown of a report. */
export function renderMarkdown(report: Report): string {
  const others = report.arms.filter((arm) => arm.id !== report.baselineArm.id)
  const lines = [
    "# Knowledge eval report",
    "",
    `Dataset ${report.datasetVersion}. Mode: ${report.run.mode}. Query time: ${report.run.now}.`,
    `Settings: ${JSON.stringify(report.run.settings)}. Spend: ${usd(report.run.spentUsd)} of ${usd(report.run.capUsd)}.`,
    ...(report.run.stopped
      ? [
          "",
          "**The spend cap stopped the run. The report holds only the answers before the stop.**",
        ]
      : []),
    "",
    `## Comparison with the ${report.baselineArm.name}`,
    "",
    "Each arm ran the same questions on the same Workspaces, with the same requests and budgets. A change is the arm's value minus the baseline value.",
    "",
    `| Split | Category | Questions | Metric | Baseline | ${others
      .map((arm) => `${arm.name} | Change`)
      .join(" | ")} |`,
    `| --- | --- | ---: | --- | ---: | ${others.map(() => "---: | ---:").join(" | ")} |`,
  ]
  for (const row of report.comparison)
    for (const metric of METRICS) {
      const base = row.arms[report.baselineArm.id]?.[metric] ?? null
      const values = others.map((arm) => row.arms[arm.id]?.[metric] ?? null)
      if (base === null && values.every((item) => item === null)) continue
      lines.push(
        `| ${row.split} | ${row.category} | ${row.questions} | ${METRIC_NAMES[metric]} | ${value(base)} | ${others
          .map(
            (arm, index) =>
              `${value(values[index] ?? null)} | ${signed(row.change[arm.id]?.[metric])}`,
          )
          .join(" | ")} |`,
      )
    }
  lines.push(
    "",
    "## Operations",
    "",
    "| Arm | Split | Questions | Search p50 | Search p95 | get_related p50 | get_related p95 | Jev calls / question | Embedding calls / question | Cost | Errors |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.operations.map(
      (row) =>
        `| ${row.arm} | ${row.split} | ${row.questions} | ${ms(row.searchP50Ms)} | ${ms(row.searchP95Ms)} | ${ms(row.relatedP50Ms)} | ${ms(row.relatedP95Ms)} | ${row.jevCallsPerQuestion.toFixed(1)} | ${row.embeddingCallsPerQuestion.toFixed(1)} | ${usd(row.costUsd)} | ${row.errors} |`,
    ),
    "",
    `Total model cost: ${usd(report.cost.totalUsd)}.`,
    "",
    "## Changes against the kept run",
    "",
  )
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
      "## Incomplete answers",
      "",
      "The recording does not hold each model call of these answers, so the report leaves them out. Run them live to score them.",
      "",
      ...report.incomplete.map((item) => `- ${item.question} (${item.arm})`),
    )
  return `${lines.join("\n")}\n`
}
