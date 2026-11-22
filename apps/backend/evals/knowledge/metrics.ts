import type { Question } from "./dataset.js"
import type { Arm, ArmAnswer } from "./runner.js"

/*
 * The metrics of ADR-069 decision 6, from the kept answers only, so that a
 * run can be scored again with no new call:
 * - component: search recall@50, and the traversal recall of `get_related`;
 * - retrieval: recall@5, nDCG@10, a correct "no answer", correct positions;
 * - operations: p50 and p95 latency, the model calls and the cost.
 * The gold set is binary: a document is relevant or it is not.
 */

export const METRICS = [
  "recall5",
  "ndcg10",
  "searchRecall50",
  "traversalRecall",
  "noAnswer",
  "positions",
] as const
export type Metric = (typeof METRICS)[number]

export const METRIC_NAMES: Record<Metric, string> = {
  recall5: "recall@5",
  ndcg10: "nDCG@10",
  searchRecall50: "search recall@50",
  traversalRecall: "traversal recall",
  noAnswer: 'correct "no answer"',
  positions: "positions correct",
}

/** Null when the metric does not apply to the question or to the arm. */
export type MetricValues = Record<Metric, number | null>

export type QuestionScore = {
  arm: Arm
  question: string
  split: Question["split"]
  category: Question["category"]
  metrics: MetricValues
  searchMs: number
  relatedMs: number | null
  jevCalls: number
  jevQuestions: number
  embeddingCalls: number
  costUsd: number
  /**
   * The failure of the search or of `get_related`, a Jev failure of the
   * search, or the failed model calls of the answer.
   */
  error?: string
  /** The search or `get_related` gave a partial answer (for example a timeout). */
  partial: boolean
}

/** recall@k: the share of the gold documents in the first k refs. */
export function recallAt(
  refs: readonly string[],
  gold: ReadonlySet<string>,
  k: number,
): number {
  if (gold.size === 0) return 0
  return refs.slice(0, k).filter((ref) => gold.has(ref)).length / gold.size
}

/** nDCG@k with a gain of 1 for each gold document. */
export function ndcgAt(
  refs: readonly string[],
  gold: ReadonlySet<string>,
  k: number,
): number {
  const gain = (rank: number) => 1 / Math.log2(rank + 2)
  const dcg = refs
    .slice(0, k)
    .reduce((sum, ref, rank) => sum + (gold.has(ref) ? gain(rank) : 0), 0)
  let ideal = 0
  for (let rank = 0; rank < Math.min(gold.size, k); rank++) ideal += gain(rank)
  return ideal === 0 ? 0 : dcg / ideal
}

/**
 * The share of the expected position refs that the arm puts in a position
 * with the expected status.
 */
export function positionsCorrect(
  expected: NonNullable<Question["positions"]>,
  given: readonly { refs: readonly string[]; status: string }[],
): number {
  const statusOf = new Map<string, string>()
  for (const position of given)
    for (const ref of position.refs) statusOf.set(ref, position.status)
  const refs = expected.flatMap((position) =>
    position.refs.map((ref) => statusOf.get(ref) === position.status),
  )
  return refs.length === 0 ? 0 : refs.filter(Boolean).length / refs.length
}

/** Nearest-rank percentile of `values`, or null with no value. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null
}

/**
 * Score one answer. `keepAt` is the p(answers) from which the plane keeps a
 * hit: a plane search says "no answer" when no Jev-judged hit reaches it.
 * The old stack has no such threshold, so it says "no answer" only with no
 * hit. A search that failed or gave a partial answer (the time budget or a
 * Jev failure) gets no credit for "no answer". Only the plane gives
 * positions.
 */
export function scoreAnswer(
  question: Question,
  answer: ArmAnswer,
  keepAt: number,
): QuestionScore {
  const gold = new Set(question.gold)
  const noAnswer = question.category === "no-answer"
  const search = "error" in answer.search ? null : answer.search
  const refs = search?.refs ?? []
  const judged = answer.arm === "plane" && !search?.partialReason
  const kept = judged
    ? (search?.scores ?? []).filter((score) => score >= keepAt).length
    : refs.length
  const related =
    answer.related && !("error" in answer.related) ? answer.related : null
  const targets = new Set(
    question.gold.filter((ref) => !question.seeds?.includes(ref)),
  )
  // A failed model call can give a partial answer, not an error: the plane
  // gives no hits for a failed query embedding (`total_timeout`), and the
  // search order for a failed Jev call (`judge_unavailable`). The eval
  // counts these answers as errors, so that a score of 0 never hides a
  // broken call.
  const errors = [
    "error" in answer.search ? `search: ${answer.search.error}` : null,
    answer.related && "error" in answer.related
      ? `get_related: ${answer.related.error}`
      : null,
    search?.partialReason === "judge_unavailable"
      ? "search: judge_unavailable"
      : null,
    answer.calls.failed ? `${answer.calls.failed} failed model calls` : null,
  ].filter(Boolean)
  return {
    arm: answer.arm,
    question: question.id,
    split: question.split,
    category: question.category,
    metrics: {
      recall5: noAnswer ? null : recallAt(refs, gold, 5),
      ndcg10: noAnswer ? null : ndcgAt(refs, gold, 10),
      searchRecall50: noAnswer ? null : recallAt(refs, gold, 50),
      traversalRecall:
        question.seeds && targets.size > 0
          ? recallAt(related?.refs ?? [], targets, Number.POSITIVE_INFINITY)
          : null,
      noAnswer: noAnswer
        ? search && !search.partialReason && kept === 0
          ? 1
          : 0
        : null,
      positions:
        question.positions && answer.arm === "plane"
          ? positionsCorrect(question.positions, related?.positions ?? [])
          : null,
    },
    searchMs: answer.search.latencyMs,
    relatedMs: answer.related?.latencyMs ?? null,
    jevCalls: answer.calls.jev,
    jevQuestions: answer.calls.jevQuestions,
    embeddingCalls: answer.calls.embedding,
    costUsd: answer.calls.costUsd,
    ...(errors.length ? { error: errors.join("; ") } : {}),
    partial: Boolean(search?.partialReason || related?.partialReason),
  }
}

/** The mean of each metric, over the questions where it applies. */
export function meanMetrics(scores: readonly QuestionScore[]): MetricValues {
  const values = {} as MetricValues
  for (const metric of METRICS) {
    const applied = scores
      .map((score) => score.metrics[metric])
      .filter((value): value is number => value !== null)
    values[metric] = applied.length
      ? applied.reduce((sum, value) => sum + value, 0) / applied.length
      : null
  }
  return values
}

/**
 * The operations guards of a group of answers. A replay answers each model
 * call at once, so its latency is no guard: `measured` is then false and
 * each latency is null. `productBudgetMs` is the time budget of the product,
 * or null when the run does not give it.
 */
export function operations(
  scores: readonly QuestionScore[],
  measured: boolean,
  productBudgetMs: number | null = null,
) {
  const latency = (values: (number | null)[], p: number) =>
    measured
      ? percentile(
          values.filter((value): value is number => value !== null),
          p,
        )
      : null
  const sum = (pick: (score: QuestionScore) => number) =>
    scores.reduce((total, score) => total + pick(score), 0)
  const perQuestion = (total: number) =>
    scores.length ? total / scores.length : 0
  return {
    questions: scores.length,
    searchP50Ms: latency(
      scores.map((score) => score.searchMs),
      50,
    ),
    searchP95Ms: latency(
      scores.map((score) => score.searchMs),
      95,
    ),
    relatedP50Ms: latency(
      scores.map((score) => score.relatedMs),
      50,
    ),
    relatedP95Ms: latency(
      scores.map((score) => score.relatedMs),
      95,
    ),
    jevCallsPerQuestion: perQuestion(sum((score) => score.jevCalls)),
    jevQuestionsPerQuestion: perQuestion(sum((score) => score.jevQuestions)),
    embeddingCallsPerQuestion: perQuestion(
      sum((score) => score.embeddingCalls),
    ),
    costUsd: sum((score) => score.costUsd),
    errors: scores.filter((score) => score.error).length,
    partial: scores.filter((score) => score.partial).length,
    /** The answers with a call that took longer than the product budget. */
    overProductBudget:
      measured && productBudgetMs
        ? scores.filter((score) => overBudget(score, productBudgetMs)).length
        : null,
  }
}

/** True when the search or `get_related` of `score` took longer than `budgetMs`. */
export function overBudget(score: QuestionScore, budgetMs: number): boolean {
  return score.searchMs > budgetMs || (score.relatedMs ?? 0) > budgetMs
}
