// The report of the bake-off: the metrics of each arm on the hold-out set
// and on the other cases, the selection rule, and the agreement on each
// quality. See README.md beside this file for the definitions.

import { qualities } from "../../src/rubric.ts"
import type { Box } from "../../src/story.ts"
import type { Verdict } from "../../src/verdict.ts"
import type { CaseManifest } from "./cases.ts"

/** The limit or the input error that stopped a run. */
export type StopReason = "cost" | "time" | "image"

/** The verdict of one arm on one case in one run. */
export type Result = {
  arm: string
  case: string
  run: number
  verdict: Verdict
}

type Metrics = {
  recall: number | undefined
  precision: number | undefined
  unsure: number
  errors: number
  severity: number | undefined
  quality: number | undefined
  byQuality: Map<string, number | undefined>
  overlap: number | undefined
  consistency: number | undefined
  cost: number | undefined
  p50: number
  p95: number
  taste: number | undefined
  judged: number
}

const mean = (values: readonly number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(key(item))
    if (group) group.push(item)
    else groups.set(key(item), [item])
  }
  return groups
}

/** The delta of the quality `id` in a verdict, or undefined without one. */
const deltaIn = (verdict: Verdict, id: string) =>
  verdict.qualities.find(({ name }) => name === id)?.delta

const share = <T>(items: readonly T[], test: (item: T) => boolean) =>
  items.length ? items.filter(test).length / items.length : undefined

/** The nearest-rank percentile of `values`. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

/** The most common value, or undefined when two values share the top. */
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const [top, next] = ranked
  return top && (!next || next[1] < top[1]) ? top[0] : undefined
}

function iou(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  const inside = Math.max(0, width) * Math.max(0, height)
  const union = a.width * a.height + b.width * b.height - inside
  return union > 0 ? inside / union : 0
}

/**
 * The metrics of each arm on the results `rows` (all arms, the same cases and
 * runs). The cases have no severity or quality labels, so the agreement on
 * severity and on a quality compares an arm with the most common value of
 * all arms on the same case and run (for a quality, of the arms that rate it,
 * when two or more do).
 */
function measure(
  arms: readonly string[],
  rows: readonly Result[],
  manifest: CaseManifest,
  regions: ReadonlyMap<string, Box | null>,
  runs: number,
): Map<string, Metrics> {
  const label = new Map(manifest.cases.map(({ id, label }) => [id, label]))
  const key = ({ case: id, run }: Result) => `${id}#${run}`
  const byTask = groupBy(rows, key)
  const severityOf = new Map(
    [...byTask].map(([task, results]) => [
      task,
      mode(results.map(({ verdict }) => verdict.severity)),
    ]),
  )
  const deltaOf = new Map(
    [...byTask].map(([task, results]) => [
      task,
      new Map(
        qualities.map(({ id }) => {
          const deltas = results.flatMap(
            ({ verdict }) => deltaIn(verdict, id) ?? [],
          )
          return [id, deltas.length > 1 ? mode(deltas) : undefined]
        }),
      ),
    ]),
  )
  const cases = new Set(rows.map(({ case: id }) => id))
  const picks = (manifest.taste ?? []).filter((pick) => cases.has(pick.case))

  const metrics = new Map<string, Metrics>()
  for (const arm of arms) {
    const own = rows.filter((result) => result.arm === arm)
    const flagged = own.filter(
      ({ verdict }) => verdict.verdict === "regression",
    )
    // Only the verdicts that give a value, where the arms have a most
    // common value. A judge gives a quality only when it applies.
    const agreement = (
      expected: (result: Result) => string | undefined,
      actual: (result: Result) => string | undefined,
    ) =>
      share(
        own.filter(
          (result) =>
            expected(result) !== undefined && actual(result) !== undefined,
        ),
        (result) => actual(result) === expected(result),
      )
    const byQuality = new Map(
      qualities.map(({ id }) => [
        id,
        agreement(
          (result) => deltaOf.get(key(result))?.get(id),
          ({ verdict }) => deltaIn(verdict, id),
        ),
      ]),
    )
    const overlaps = flagged.flatMap(({ case: id, verdict }) => {
      const known = regions.get(id)
      if (!known) return []
      return [
        Math.max(
          0,
          ...verdict.findings.map(({ region }) => iou(region, known)),
        ),
      ]
    })
    const verdictsByCase = groupBy(own, ({ case: id }) => id)
    const costs = own.map(({ verdict }) => verdict.costUsd)
    const latencies = own.map(({ verdict }) => verdict.latencyMs)
    const ownPicks = picks.filter(({ arms }) => arms.includes(arm))
    metrics.set(arm, {
      recall: share(
        own.filter(({ case: id }) => label.get(id) === "regression"),
        ({ verdict }) => verdict.verdict === "regression",
      ),
      precision: share(
        flagged,
        ({ case: id }) => label.get(id) === "regression",
      ),
      unsure: share(own, ({ verdict }) => verdict.verdict === "unsure") ?? 0,
      errors: own.filter(({ verdict }) => verdict.error !== undefined).length,
      severity: agreement(
        (result) => severityOf.get(key(result)),
        ({ verdict }) => verdict.severity,
      ),
      quality: mean(
        [...byQuality.values()].filter((value) => value !== undefined),
      ),
      byQuality,
      overlap: mean(overlaps),
      consistency:
        runs > 1
          ? share(
              [...verdictsByCase.values()].filter(
                (results) => results.length === runs,
              ),
              (results) =>
                results.every(
                  ({ verdict }) =>
                    verdict.verdict === results[0]?.verdict.verdict,
                ),
            )
          : undefined,
      cost: mean(costs.filter((cost) => cost !== null)),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      taste: ownPicks.length
        ? ownPicks.reduce(
            (score, { winner }) =>
              score + (winner === arm ? 1 : winner === "tie" ? 0.5 : 0),
            0,
          ) / ownPicks.length
        : undefined,
      judged: own.length,
    })
  }
  return metrics
}

const ratio = (value: number | undefined) =>
  value === undefined ? "–" : value.toFixed(2)

function table(
  metrics: ReadonlyMap<string, Metrics>,
  tasteLabels: boolean,
  name: (arm: string) => string,
): string {
  const lines = [
    "| Arm | Recall | Precision | Unsure | Errors | Severity agreement | Quality agreement | Region overlap | Consistency | Cost per story | p50 ms | p95 ms | Taste win rate | Verdicts |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const [arm, m] of metrics)
    lines.push(
      `| ${[
        name(arm),
        ratio(m.recall),
        ratio(m.precision),
        ratio(m.unsure),
        m.errors,
        ratio(m.severity),
        ratio(m.quality),
        ratio(m.overlap),
        ratio(m.consistency),
        m.cost === undefined ? "unknown" : `$${m.cost.toFixed(4)}`,
        Math.round(m.p50),
        Math.round(m.p95),
        tasteLabels ? ratio(m.taste) : "no labels yet",
        m.judged,
      ].join(" | ")} |`,
    )
  return lines.join("\n")
}

/**
 * The selection rule: of the arms with recall ≥ 0.9 and precision ≥ 0.7 on
 * the hold-out set, the cheapest. Arms with the same cost per story (to
 * $0.0001) tie; the taste win rate breaks the tie. An arm with no known cost
 * comes after the others.
 */
function select(metrics: ReadonlyMap<string, Metrics>): string {
  const costUnits = (m: Metrics) =>
    m.cost === undefined ? Infinity : Math.round(m.cost * 10_000)
  const eligible = [...metrics]
    .filter(([, m]) => (m.recall ?? 0) >= 0.9 && (m.precision ?? 0) >= 0.7)
    .sort(([, a], [, b]) => costUnits(a) - costUnits(b))
  const [first] = eligible
  if (!first)
    return "No arm has recall ≥ 0.9 and precision ≥ 0.7 on the hold-out set."
  const names = eligible.map(([arm]) => `\`${arm}\``).join(", ")
  const tied = eligible.filter(([, m]) => costUnits(m) === costUnits(first[1]))
  if (tied.length === 1)
    return `Selected: \`${first[0]}\`, the cheapest of the arms with recall ≥ 0.9 and precision ≥ 0.7 on the hold-out set (${names}).`
  const best = Math.max(...tied.map(([, m]) => m.taste ?? -1))
  const winners = tied.filter(
    ([, m]) => m.taste !== undefined && m.taste === best,
  )
  if (winners.length === 1 && winners[0])
    return `Selected: \`${winners[0][0]}\`. It ties on cost with ${tied.length - 1} other arms of recall ≥ 0.9 and precision ≥ 0.7, and has the highest taste win rate.`
  return `No single arm: ${tied.map(([arm]) => `\`${arm}\``).join(", ")} have recall ≥ 0.9, precision ≥ 0.7 and the same cost, and the taste win rate does not break the tie.`
}

/**
 * The table of the new screenshots: for each arm, the recall on the broken
 * ones, the false alarms on the clean ones, and the cost per story. An arm
 * that is not in `newArms` cannot judge a new screenshot: its row says so.
 */
function newTable(
  arms: readonly string[],
  newArms: readonly string[],
  rows: readonly Result[],
  manifest: CaseManifest,
  name: (arm: string) => string,
): string {
  const label = new Map(manifest.cases.map(({ id, label }) => [id, label]))
  const lines = [
    "| Arm | Recall (broken) | False alarms (clean) | Unsure | Errors | Cost per story | Verdicts |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const arm of arms) {
    if (!newArms.includes(arm)) {
      lines.push(`| ${name(arm)} | not applicable | | | | | |`)
      continue
    }
    const own = rows.filter((result) => result.arm === arm)
    // The share of regression verdicts on the broken or on the clean ones.
    const flagged = (broken: boolean) =>
      share(
        own.filter(
          ({ case: id }) => (label.get(id) === "regression") === broken,
        ),
        ({ verdict }) => verdict.verdict === "regression",
      )
    const cost = mean(
      own.flatMap(({ verdict }) =>
        verdict.costUsd === null ? [] : [verdict.costUsd],
      ),
    )
    lines.push(
      `| ${[
        name(arm),
        ratio(flagged(true)),
        ratio(flagged(false)),
        ratio(share(own, ({ verdict }) => verdict.verdict === "unsure")),
        own.filter(({ verdict }) => verdict.error !== undefined).length,
        cost === undefined ? "unknown" : `$${cost.toFixed(4)}`,
        own.length,
      ].join(" | ")} |`,
    )
  }
  return lines.join("\n")
}

/** The report of a bake-off run, as Markdown. */
export function report({
  manifest,
  holdOut,
  arms,
  newArms,
  runs,
  results,
  regions,
  stopped,
  spend,
}: {
  manifest: CaseManifest
  holdOut: ReadonlySet<string>
  arms: readonly string[]
  /** The arms that judge a new screenshot. */
  newArms: readonly string[]
  runs: number
  results: readonly Result[]
  regions: ReadonlyMap<string, Box | null>
  stopped: StopReason | undefined
  spend: { spent: number; maxCost: number; unknownCost: number }
}): string {
  // Only the cases and runs that every arm judged count, so that a run that
  // the cap stopped compares the arms on the same cases. A new screenshot
  // has its own table, with only the arms that judge one.
  const isNew = new Set(
    manifest.cases.filter(({ kind }) => kind === "new").map(({ id }) => id),
  )
  const done = groupBy(results, ({ case: id, run }) => `${id}#${run}`)
  const complete = (rows: readonly Result[], count: number) =>
    rows.filter(
      ({ case: id, run }) => done.get(`${id}#${run}`)?.length === count,
    )
  const common = complete(
    results.filter(({ case: id }) => !isNew.has(id)),
    arms.length,
  )
  const newRows = complete(
    results.filter(({ case: id }) => isNew.has(id)),
    newArms.length,
  )
  const held = common.filter(({ case: id }) => holdOut.has(id))
  const rest = common.filter(({ case: id }) => !holdOut.has(id))
  const tasteLabels = (manifest.taste ?? []).length > 0
  const heldMetrics = measure(arms, held, manifest, regions, runs)
  const restMetrics = measure(arms, rest, manifest, regions, runs)
  const count = (rows: readonly Result[]) =>
    new Set(rows.map(({ case: id }) => id)).size
  // An arm that uses a model of the judge panel (CTX-1249) is marked: the
  // panel labels of the real changes can favor it.
  const panel = manifest.panelModels ?? []
  const name = (arm: string) =>
    arm.split(/[:+]/).some((part) => panel.includes(part))
      ? `\`${arm}\` (panel)`
      : `\`${arm}\``

  const lines = [
    "# Visual critic bake-off",
    "",
    `Cases: ${manifest.cases.length} (${holdOut.size} in the hold-out set, ${isNew.size} new screenshots). Runs: ${runs}. Arms: ${arms.length}.`,
    `Spend: $${spend.spent.toFixed(2)} of the $${spend.maxCost} cap.${
      stopped
        ? ` The ${{ cost: "spend cap", time: "time limit", image: "check of the case images" }[stopped]} stopped the run: the tables count only the cases and runs that every arm judged.`
        : ""
    }${
      spend.unknownCost
        ? ` ${spend.unknownCost} calls gave no cost: the spend counts each one as the most expensive call so far, and at least $0.10; the cost per story leaves them out.`
        : ""
    }`,
    panel.length
      ? `The labels of the real changes come from the judge panel (${panel.join(", ")}). An arm marked (panel) uses a model of the panel, so the labels can favor it.`
      : "The real changes have no panel labels yet (node packages/visual-review/evals/critic/panel.ts), so they do not count.",
    "",
    `## Hold-out set (${count(held)} cases)`,
    "",
    table(heldMetrics, tasteLabels, name),
    "",
    select(heldMetrics),
    "",
    `## Other cases (${count(rest)} cases)`,
    "",
    table(restMetrics, tasteLabels, name),
    "",
    `## New screenshots (${count(newRows)} cases)`,
    "",
    "A new screenshot has no before image: the judge rates it on its own against the rubric. A broken one has a synthetic regression. A false alarm is a regression verdict on a clean one. The hold-out set and the selection rule do not use these cases.",
    "",
    newTable(arms, newArms, newRows, manifest, name),
    "",
    "## Agreement on each quality (hold-out set)",
    "",
    `| Arm | ${qualities.map(({ id }) => id).join(" | ")} |`,
    `| --- | ${qualities.map(() => "---:").join(" | ")} |`,
    ...[...heldMetrics].map(
      ([arm, m]) =>
        `| ${name(arm)} | ${qualities.map(({ id }) => ratio(m.byQuality.get(id))).join(" | ")} |`,
    ),
  ]
  return lines.join("\n")
}
