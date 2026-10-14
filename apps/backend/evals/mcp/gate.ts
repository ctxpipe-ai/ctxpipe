import type { ToolSetMode } from "./check.js"

/** Passed iterations out of all iterations of one case, for one model. */
export type CaseScore = { passes: number; iterations: number }

export type RunResult = {
  mode: ToolSetMode
  /** Model name, then case id. */
  models: Record<string, Record<string, CaseScore>>
}

export type BaselineModel = { aggregate: number; cases: Record<string, number> }

/** Pass rates stored in git after a recorded run. One entry for each tool set. */
export type BaselineEntry = {
  recordedAt: string
  models: Record<string, BaselineModel>
}

export type Baseline = Record<ToolSetMode, BaselineEntry | null>

export const gateThresholds = {
  /** Each model must pass this share of all iterations. */
  minPassRate: 0.9,
  /** Largest allowed fall of the aggregate pass rate from the baseline. */
  maxAggregateDrop: 0.05,
  /** Largest allowed fall of one case. With 3 iterations, one lost iteration is 0.33. */
  maxCaseDrop: 0.34,
} as const

export type GateReport = {
  passed: boolean
  failures: string[]
  notes: string[]
  aggregates: Record<string, number>
}

const epsilon = 1e-9

function rate(score: CaseScore): number {
  return score.iterations === 0 ? 0 : score.passes / score.iterations
}

function aggregate(cases: Record<string, CaseScore>): number {
  const scores = Object.values(cases)
  const iterations = scores.reduce((sum, score) => sum + score.iterations, 0)
  const passes = scores.reduce((sum, score) => sum + score.passes, 0)
  return iterations === 0 ? 0 : passes / iterations
}

/**
 * Decide whether a run may pass CI. The run fails when a model misses the
 * pass-rate floor, when an expected case has no result, or when the pass rate
 * falls from the stored baseline by more than the thresholds.
 */
export function evaluateGate(
  result: RunResult,
  baseline: BaselineEntry | null,
  expectedCaseIds: readonly string[],
): GateReport {
  const failures: string[] = []
  const notes: string[] = []
  const aggregates: Record<string, number> = {}
  const models = Object.keys(result.models)
  if (models.length === 0) failures.push("no model ran")
  for (const model of models) {
    const cases = result.models[model] ?? {}
    for (const id of expectedCaseIds) {
      const score = cases[id]
      if (!score || score.iterations === 0)
        failures.push(`${model}: case ${id} has no result`)
    }
    const total = aggregate(cases)
    aggregates[model] = total
    if (total + epsilon < gateThresholds.minPassRate)
      failures.push(
        `${model}: pass rate ${total.toFixed(3)} is below ${gateThresholds.minPassRate}`,
      )
    const stored = baseline?.models[model]
    if (!stored) {
      if (baseline) notes.push(`${model}: no baseline for this model`)
      continue
    }
    if (stored.aggregate - total > gateThresholds.maxAggregateDrop + epsilon)
      failures.push(
        `${model}: pass rate fell from ${stored.aggregate.toFixed(3)} to ${total.toFixed(3)}`,
      )
    for (const [id, before] of Object.entries(stored.cases)) {
      const score = cases[id]
      if (!score) continue
      if (before - rate(score) > gateThresholds.maxCaseDrop + epsilon)
        failures.push(
          `${model}: case ${id} fell from ${before.toFixed(2)} to ${rate(score).toFixed(2)}`,
        )
    }
  }
  if (!baseline)
    notes.push(`no stored baseline for ${result.mode}; floor check only`)
  for (const model of Object.keys(baseline?.models ?? {})) {
    if (!models.includes(model))
      failures.push(`${model}: in the baseline but did not run`)
  }
  return { passed: failures.length === 0, failures, notes, aggregates }
}

/** The baseline entry that a recorded run writes. */
export function baselineFromRun(
  result: RunResult,
  recordedAt: string,
): BaselineEntry {
  return {
    recordedAt,
    models: Object.fromEntries(
      Object.entries(result.models).map(([model, cases]) => [
        model,
        {
          aggregate: Number(aggregate(cases).toFixed(4)),
          cases: Object.fromEntries(
            Object.entries(cases).map(([id, score]) => [
              id,
              Number(rate(score).toFixed(4)),
            ]),
          ),
        },
      ]),
    ),
  }
}
