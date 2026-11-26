import type { Question } from "./dataset.js"
import type { Arm, ArmAnswer } from "./runner.js"

/*
 * The metrics of ADR-069 decision 6, from the kept answers only, so that a
 * run can be scored again with no new call:
 * - component: search recall@50, and the traversal recall of `get_related`;
 * - retrieval: recall@5, nDCG@10, a correct "no answer", the disagreements
 *   shown;
 * - operations: p50 and p95 latency, the model calls and the cost.
 * The gold set is binary: a document is relevant or it is not.
 */

export const METRICS = [
  "recall5",
  "ndcg10",
  "searchRecall50",
  "traversalRecall",
  "noAnswer",
  "disagreements",
] as const
export type Metric = (typeof METRICS)[number]

export const METRIC_NAMES: Record<Metric, string> = {
  recall5: "recall@5",
  ndcg10: "nDCG@10",
  searchRecall50: "search recall@50",
  traversalRecall: "traversal recall",
  noAnswer: 'correct "no answer"',
  disagreements: "disagreements shown",
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
  /** The Jev calls that the client sent twice, because the provider was slow. */
  hedged: number
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

/** The predicates of a claim that one document replaces another. */
const REPLACE_PREDICATES = new Set(["SUPERSEDES", "REPLACES"])

/** The predicates of a claim that two documents disagree. */
const DISAGREE_PREDICATES = new Set([
  ...REPLACE_PREDICATES,
  "CONTRADICTS",
  "PARTLY_CONTRADICTS",
])

/**
 * The disagreements shown: the share of the pairs of expected refs in two
 * different positions that the arm links by a claim that tells the
 * disagreement, in either direction: a stored SUPERSEDES or a reading of
 * the model. A claim that a ref of a `superseded` position replaces a ref
 * of a `current` position tells the wrong direction, so it does not count.
 * A ref that the claims do not hold makes each of its pairs not shown.
 */
export function disagreementsShown(
  expected: NonNullable<Question["positions"]>,
  claims: readonly { from: string; to: string; predicate: string }[],
): number {
  const statusOf = new Map(
    expected.flatMap(({ refs, status }) => refs.map((ref) => [ref, status])),
  )
  const tells = (claim: (typeof claims)[number]) =>
    DISAGREE_PREDICATES.has(claim.predicate) &&
    !(
      REPLACE_PREDICATES.has(claim.predicate) &&
      statusOf.get(claim.from) === "superseded" &&
      statusOf.get(claim.to) === "current"
    )
  const pairs = expected.flatMap((position, index) =>
    expected
      .slice(index + 1)
      .flatMap((other) =>
        position.refs.flatMap((a) => other.refs.map((b) => [a, b] as const)),
      ),
  )
  const shown = pairs.filter(([a, b]) =>
    claims.some(
      (claim) =>
        ((claim.from === a && claim.to === b) ||
          (claim.from === b && claim.to === a)) &&
        tells(claim),
    ),
  )
  return pairs.length === 0 ? 0 : shown.length / pairs.length
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
 * claims.
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
  // The "no answer" of the search, which the `noAnswer` metric also reads.
  // A client that reads "no answer" does not use the hits, so the retrieval
  // metrics score the search as an empty result (CTX-1562). The old stack
  // says "no answer" only with no hit, so its scores do not change.
  const saysNoAnswer = Boolean(search && !search.partialReason && kept === 0)
  const usedRefs = saysNoAnswer ? [] : refs
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
      recall5: noAnswer ? null : recallAt(usedRefs, gold, 5),
      ndcg10: noAnswer ? null : ndcgAt(usedRefs, gold, 10),
      searchRecall50: noAnswer ? null : recallAt(usedRefs, gold, 50),
      traversalRecall:
        question.seeds && targets.size > 0
          ? recallAt(related?.refs ?? [], targets, Number.POSITIVE_INFINITY)
          : null,
      noAnswer: noAnswer ? (saysNoAnswer ? 1 : 0) : null,
      disagreements:
        question.positions && answer.arm === "plane"
          ? disagreementsShown(question.positions, related?.claims ?? [])
          : null,
    },
    searchMs: answer.search.latencyMs,
    relatedMs: answer.related?.latencyMs ?? null,
    jevCalls: answer.calls.jev,
    jevQuestions: answer.calls.jevQuestions,
    embeddingCalls: answer.calls.embedding,
    hedged: answer.calls.hedged,
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
    /** The Jev calls that the client sent twice (provider stalls). */
    hedged: sum((score) => score.hedged),
    errors: scores.filter((score) => score.error).length,
    partial: scores.filter((score) => score.partial).length,
    /** The answers with a call that took longer than the product budget. */
    overProductBudget:
      measured && productBudgetMs
        ? scores.filter(
            (score) => overBudgetCalls(score, productBudgetMs).length > 0,
          ).length
        : null,
  }
}

/** The calls of `score` that took longer than `budgetMs`, with their latency. */
export function overBudgetCalls(
  score: QuestionScore,
  budgetMs: number,
): { call: "search" | "get_related"; ms: number }[] {
  return [
    { call: "search" as const, ms: score.searchMs },
    { call: "get_related" as const, ms: score.relatedMs ?? 0 },
  ].filter(({ ms }) => ms > budgetMs)
}
