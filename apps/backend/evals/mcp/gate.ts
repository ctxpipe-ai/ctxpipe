/**
 * A run: the requested iterations of each case, and the passed iterations for
 * each model and case. The pass rate divides by the requested iterations, so
 * an iteration that threw or timed out counts as a failure.
 */
export type RunResult = {
  iterations: number
  /** Model name, then case id, then passed iterations. */
  passes: Record<string, Record<string, number>>
}

export type BaselineModel = { aggregate: number; cases: Record<string, number> }

/** Pass rates stored in git after a recorded run. `null` until the first record. */
export type Baseline = {
  recordedAt: string
  models: Record<string, BaselineModel>
} | null

export const gateThresholds = {
  /** A run compares at least this number of client models. */
  minModels: 2,
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

function rates(
  result: RunResult,
  model: string,
  caseIds: readonly string[],
): { aggregate: number; cases: Record<string, number> } {
  const passes = result.passes[model] ?? {}
  const cases = Object.fromEntries(
    caseIds.map((id) => [
      id,
      result.iterations > 0 ? (passes[id] ?? 0) / result.iterations : 0,
    ]),
  )
  const values = Object.values(cases)
  const aggregate =
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length
  return { aggregate, cases }
}

/**
 * Decide whether a run may pass CI. The run fails when fewer than two models
 * ran, when a model misses the pass-rate floor, when an expected case has no
 * result, or when the pass rate falls from the stored baseline by more than
 * the thresholds.
 */
export function evaluateGate(
  result: RunResult,
  baseline: Baseline,
  expectedCaseIds: readonly string[],
): GateReport {
  const failures: string[] = []
  const notes: string[] = []
  const aggregates: Record<string, number> = {}
  const models = Object.keys(result.passes)
  if (models.length < gateThresholds.minModels)
    failures.push(
      `a run needs at least ${gateThresholds.minModels} models, got ${models.length}`,
    )
  if (result.iterations < 1) failures.push("a run needs at least 1 iteration")
  for (const model of models) {
    const passes = result.passes[model] ?? {}
    for (const id of expectedCaseIds) {
      if (passes[id] === undefined)
        failures.push(`${model}: case ${id} has no result`)
    }
    const { aggregate, cases } = rates(result, model, expectedCaseIds)
    aggregates[model] = aggregate
    if (aggregate + epsilon < gateThresholds.minPassRate)
      failures.push(
        `${model}: pass rate ${aggregate.toFixed(3)} is below ${gateThresholds.minPassRate}`,
      )
    const stored = baseline?.models[model]
    if (!stored) {
      if (baseline) notes.push(`${model}: no baseline for this model`)
      continue
    }
    if (
      stored.aggregate - aggregate >
      gateThresholds.maxAggregateDrop + epsilon
    )
      failures.push(
        `${model}: pass rate fell from ${stored.aggregate.toFixed(3)} to ${aggregate.toFixed(3)}`,
      )
    for (const [id, before] of Object.entries(stored.cases)) {
      const now = cases[id]
      if (now === undefined) continue
      if (before - now > gateThresholds.maxCaseDrop + epsilon)
        failures.push(
          `${model}: case ${id} fell from ${before.toFixed(2)} to ${now.toFixed(2)}`,
        )
    }
  }
  if (!baseline)
    notes.push(
      `no stored baseline; only the ${gateThresholds.minPassRate} floor applies`,
    )
  for (const model of Object.keys(baseline?.models ?? {})) {
    if (!models.includes(model))
      failures.push(`${model}: in the baseline but did not run`)
  }
  return { passed: failures.length === 0, failures, notes, aggregates }
}

/** The baseline that a recorded run writes. */
export function baselineFromRun(
  result: RunResult,
  caseIds: readonly string[],
  recordedAt: string,
): NonNullable<Baseline> {
  const round = (value: number) => Number(value.toFixed(4))
  return {
    recordedAt,
    models: Object.fromEntries(
      Object.keys(result.passes).map((model) => {
        const { aggregate, cases } = rates(result, model, caseIds)
        return [
          model,
          {
            aggregate: round(aggregate),
            cases: Object.fromEntries(
              Object.entries(cases).map(([id, rate]) => [id, round(rate)]),
            ),
          },
        ]
      }),
    ),
  }
}
