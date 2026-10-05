/**
 * Read-time retrieval score for a candidate edge of the graph walk (ADR-040).
 *
 * Each signal is a number in (0, 1]. The score is the weighted product of the
 * signals, exp(Σ wᵢ · ln sᵢ). Each signal has a floor, so one weak signal
 * makes a fact rank lower but cannot remove it. The weights are in this file
 * and apply when the walk reads the graph, so a change needs no reindex.
 *
 * This module has no imports, so an evaluation can copy it with the walk.
 */

export type RetrievalSignals = {
  /** Is the fact true: evidence combined with noisy-OR, multiplied along the path */
  truth: number
  /** Must the fact govern: the ADR status, the pull request review decision */
  authority: number
  /** Did the search for the question find the node: 0.5 for a miss, 1 for the top hit */
  search: number
  /** Is the fact current: pull requests and threads decay, other facts do not */
  recency: number
  /** Is the fact about this node: a penalty for hub nodes */
  specificity: number
}

export type SignalName = keyof RetrievalSignals

/** The exponent of each signal. 0 switches the signal off. */
export type SignalWeights = Record<SignalName, number>

export type QueryIntent =
  | "ownership"
  | "why"
  | "change"
  | "structure"
  | "general"

const SIGNAL_NAMES: SignalName[] = [
  "truth",
  "authority",
  "search",
  "recency",
  "specificity",
]

/** No signal goes below this value, so ln() stays finite and no fact is removed. */
export const SIGNAL_FLOOR = 0.05

/**
 * Evidence rows are distinct logical sources (an extractor and its target,
 * without the commit hash). A repeat observation of a source updates its row
 * and does not add one. But two extractors can read the same file, one
 * extractor can see the same fact in two packages, and a mirror copies a
 * source, so the sources are not fully independent. Noisy-OR assumes that
 * they are (NELL), thus it counts at most three of them.
 * Follow-up: group the evidence by an independence key (producer and
 * upstream artifact) when the claim is written, and combine one value for
 * each group, as Knowledge Vault counts each domain once.
 */
const MAX_INDEPENDENT_SOURCES = 3

/** No combination of evidence makes a fact certain. */
const MAX_TRUTH = 0.98

/** Half-life of pull requests and threads. */
const RECENCY_HALF_LIFE_DAYS = 90

/** An old event still counts for this much. */
const RECENCY_FLOOR = 0.1

/** A decaying fact with no date counts as one half-life old. */
const UNDATED_RECENCY = 0.5

/** The search signal of a node that the search did not find. */
const SEARCH_MISS = 0.5

/**
 * The file change types, and the derived pull request change to a package.
 * They share one turn in the walk, and their `valid_from` is the merge date.
 */
export const CHANGE_FAMILY: ReadonlySet<string> = new Set([
  "CHANGED",
  "ADDED",
  "MODIFIED",
  "REMOVED",
  "RENAMED",
])

/** Edges whose `valid_from` is the merge date of a pull request. */
const DATED_EDGES: ReadonlySet<string> = new Set([...CHANGE_FAMILY, "TARGETS"])

/**
 * ADR lifecycle (Nygard, MADR): in force, then undeclared, then not yet in
 * force, then no longer in force (ADR-036).
 */
export const DECISION_STATUS_FACTORS: Readonly<Record<string, number>> = {
  accepted: 1,
  proposed: 0.6,
  draft: 0.6,
  deprecated: 0.3,
  superseded: 0.3,
  rejected: 0.3,
}
export const UNDECLARED_DECISION_FACTOR = 0.9

/**
 * GitHub review decision of a merged pull request. Many teams merge without
 * a formal review, so no review costs less than an open change request.
 */
const REVIEW_DECISION_FACTORS: Readonly<Record<string, number>> = {
  APPROVED: 1,
  CHANGES_REQUESTED: 0.6,
}
const UNREVIEWED_FACTOR = 0.8

/**
 * Every weight starts at 1 (a log-linear model, Metzler and Croft), except
 * recency: a recency prior helps only questions about time (Li and Croft).
 */
const BASE_WEIGHTS: SignalWeights = {
  truth: 1,
  authority: 1,
  search: 1,
  recency: 0,
  specificity: 1,
}

/** The predicates that describe how the code is built and connected. */
const STRUCTURAL_PREDICATES = [
  "DEPENDS_ON",
  "CONSUMES_API",
  "EXPOSES_API",
  "HAS_OPERATION",
  "PRODUCES_TO",
  "CONSUMES_FROM",
  "READS_FROM",
  "WRITES_TO",
  "USES_LIBRARY",
  "RUNS_ON",
]

export type IntentProfile = {
  weights: SignalWeights
  /** Turns of a relation family in each round of the walk (default 1), by {@link turnGroup} */
  turns: Readonly<Record<string, number>>
  /**
   * True when the question asks about history. Then a superseded, rejected
   * or proposed ADR is part of the answer, and its status does not lower it.
   */
  history: boolean
}

export const INTENT_PROFILES: Readonly<Record<QueryIntent, IntentProfile>> = {
  general: { weights: BASE_WEIGHTS, turns: {}, history: false },
  // A team that owns many services and issues is still the owner.
  ownership: {
    weights: { ...BASE_WEIGHTS, specificity: 0 },
    turns: { OWNS: 3 },
    history: false,
  },
  // The ADRs come before the files that declare them and the changes to
  // those files.
  why: {
    weights: BASE_WEIGHTS,
    turns: { INFLUENCES: 3, SUPERSEDES: 2 },
    history: true,
  },
  // The question is about time. A pull request that changed many files still
  // changed the package, and a recent large change is often the answer: on two
  // real org graphs, the hub penalty lowered recall of the newest pull
  // requests by 0.07 to 0.16. No specificity.
  change: {
    weights: { ...BASE_WEIGHTS, recency: 1, specificity: 0 },
    turns: { CHANGED: 3, TARGETS: 3, REFERENCES: 2 },
    history: true,
  },
  structure: {
    weights: BASE_WEIGHTS,
    turns: Object.fromEntries(STRUCTURAL_PREDICATES.map((p) => [p, 3])),
    history: false,
  },
}

/** The first intent whose pattern matches the question wins. */
const INTENT_PATTERNS: ReadonlyArray<[QueryIntent, RegExp]> = [
  [
    "why",
    /\b(why|decide|decided|decision|decisions|adrs?|rationale|reasons?)\b/i,
  ],
  [
    "ownership",
    /\b(owners?|owns|owned|ownership|codeowners|maintainers?|teams?)\b|\bwho\b(?!\s+(calls?|uses|used|changed|modified|touched|added|removed|depends|consumes|reads|writes))/i,
  ],
  [
    "change",
    /\b(recent|recently|lately|changed|prs?|pull\s+requests?|prior\s+work|tried|history|merged)\b/i,
  ],
  [
    "structure",
    /\b(depends?|dependency|dependencies|dependents?|calls?|callers?|uses|used\s+by|consumes?|consumers?|apis?|endpoints?|databases?|db)\b/i,
  ],
]

/** Classifies the question with fixed patterns: no model call. */
export function classifyIntent(query: string | undefined): QueryIntent {
  if (!query) return "general"
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(query)) return intent
  }
  return "general"
}

/** The family that takes turns in the walk: the change types share one. */
export function turnGroup(predicate: string): string {
  return CHANGE_FAMILY.has(predicate) ? "CHANGED" : predicate
}

/**
 * The profile for a walk. `intent` replaces the intent of `query`, and
 * `weights` replaces single signal weights of that intent.
 */
export function retrievalProfile(options: {
  query?: string
  intent?: QueryIntent
  weights?: Partial<SignalWeights>
}): IntentProfile & { intent: QueryIntent } {
  const intent = options.intent ?? classifyIntent(options.query)
  const profile = INTENT_PROFILES[intent]
  return {
    ...profile,
    intent,
    weights: { ...profile.weights, ...options.weights },
  }
}

/**
 * Truth of one edge: noisy-OR of its evidence, 1 - (1 - c)^n, at most
 * {@link MAX_TRUTH}. `c` is the stored confidence (0.5 when missing) and `n`
 * the evidence count, at least 1 and at most {@link MAX_INDEPENDENT_SOURCES}.
 * Agreement raises it: two sources at 0.6 give 0.84, but one source at 0.95
 * still beats three at 0.6. Recency is not part of truth. (The stored
 * confidence is an average of the evidence, weighted with a 90-day decay of
 * each row; for one row the weight cancels.)
 */
export function edgeTruth(
  confidence: number | null,
  sourceCount: number | null,
): number {
  const c = Math.min(1, Math.max(0, confidence ?? 0.5))
  const n = Math.min(
    MAX_INDEPENDENT_SOURCES,
    Math.max(1, Math.floor(sourceCount ?? 1)),
  )
  return Math.min(MAX_TRUTH, 1 - (1 - c) ** n)
}

/**
 * Decision status and pull request review decision; 1 for other kinds. For a
 * question about history, the status of a decision does not lower it.
 */
export function authority(
  kind: string | null,
  status: string | null,
  reviewDecision: string | null,
  history = false,
): number {
  if (kind === "Decision") {
    if (history) return 1
    return DECISION_STATUS_FACTORS[status ?? ""] ?? UNDECLARED_DECISION_FACTOR
  }
  if (kind === "PullRequest") {
    return REVIEW_DECISION_FACTORS[reviewDecision ?? ""] ?? UNREVIEWED_FACTOR
  }
  return 1
}

/**
 * Search hits by node id, with each score divided by the top score. A hit
 * without a score counts as the top hit.
 */
export function normalizeSearchHits(
  hits: ReadonlyArray<{ id: string; score?: number }>,
): Map<string, number> {
  const scores = hits.flatMap((h) =>
    typeof h.score === "number" && h.score > 0 ? [h.score] : [],
  )
  const top = scores.length > 0 ? Math.max(...scores) : 1
  const normalized = new Map<string, number>()
  for (const hit of hits) {
    const value =
      typeof hit.score === "number" ? Math.max(0, hit.score) / top : 1
    normalized.set(hit.id, Math.max(normalized.get(hit.id) ?? 0, value))
  }
  return normalized
}

/** 0.5 for a miss; from 0.5 to 1 for a hit, by its normalized score. */
export function searchRelevance(normalizedScore: number | undefined): number {
  if (normalizedScore === undefined) return SEARCH_MISS
  return (
    SEARCH_MISS + (1 - SEARCH_MISS) * Math.min(1, Math.max(0, normalizedScore))
  )
}

/**
 * max(0.1, 2^(-age / 90 days)) for events: change edges (from their
 * `valid_from`, the merge date), pull requests (`merged_at`) and threads
 * (`captured_at`). State facts (decisions, instructions, ownership,
 * containment, dependencies) do not decay: their status, supersession and
 * validity control them. `last_observed_at` is not used: after a backfill,
 * every fact has the same ingest time. Only the `change` intent gives this
 * signal a weight.
 */
export function recency(
  input: {
    predicate: string
    validFrom: string | null
    toKind: string | null
    /** `merged_at` of a PullRequest, `captured_at` of a Thread */
    toDate: string | null
  },
  asOf: Date,
): number {
  const decays =
    DATED_EDGES.has(input.predicate) ||
    input.toKind === "PullRequest" ||
    input.toKind === "Thread"
  if (!decays) return 1
  const date = Date.parse(
    (DATED_EDGES.has(input.predicate) ? input.validFrom : null) ??
      input.toDate ??
      "",
  )
  if (Number.isNaN(date)) return UNDATED_RECENCY
  const ageDays = Math.max(0, asOf.getTime() - date) / 86_400_000
  return Math.max(RECENCY_FLOOR, 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS))
}

/**
 * degree^-0.5, as in HippoRAG and RP3β: 1 for a leaf, 0.1 for 100 edges.
 * The signal floor applies from 400 edges.
 */
export function specificity(degree: number | null): number {
  if (degree === null) return 1
  return Math.max(1, degree) ** -0.5
}

/** exp(Σ wᵢ · ln max(sᵢ, floor)): the weighted product of the signals. */
export function combineSignals(
  signals: RetrievalSignals,
  weights: SignalWeights,
): number {
  let sum = 0
  for (const name of SIGNAL_NAMES) {
    const weight = weights[name]
    if (weight === 0) continue
    sum += weight * Math.log(Math.max(SIGNAL_FLOOR, signals[name]))
  }
  return Math.exp(sum)
}

export type EdgeCandidate = {
  predicate: string
  /** Path truth of the frontier node that the edge leaves */
  parentTruth: number
  confidence: number | null
  sourceCount: number | null
  validFrom: string | null
  toKind: string | null
  toStatus: string | null
  toReviewDecision: string | null
  /** `merged_at` of a PullRequest, `captured_at` of a Thread */
  toDate: string | null
  /** Edge count of the reached node; null when not measured */
  degree: number | null
  /** From {@link normalizeSearchHits}; undefined when the search missed the node */
  searchScore: number | undefined
}

/**
 * Scores one candidate edge. `truth` is the path truth that the reached node
 * passes to the next hop. Only truth goes along the path: the other signals
 * describe the edge and the node that it reaches. A search hit gets no hub
 * penalty, because the question names it. (The start node is never a
 * candidate.)
 */
export function scoreEdge(
  candidate: EdgeCandidate,
  profile: Pick<IntentProfile, "weights" | "history">,
  asOf: Date,
): { truth: number; signals: RetrievalSignals; score: number } {
  const truth =
    candidate.parentTruth *
    edgeTruth(candidate.confidence, candidate.sourceCount)
  const signals: RetrievalSignals = {
    truth,
    authority: authority(
      candidate.toKind,
      candidate.toStatus,
      candidate.toReviewDecision,
      profile.history,
    ),
    search: searchRelevance(candidate.searchScore),
    recency: recency(candidate, asOf),
    specificity:
      candidate.searchScore === undefined ? specificity(candidate.degree) : 1,
  }
  return { truth, signals, score: combineSignals(signals, profile.weights) }
}
