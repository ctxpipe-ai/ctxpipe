/**
 * Graph relevance for `get_related` (ADR-051 section 6). This module has no
 * I/O: the caller gives the explored subgraph, the seeds, and the query hits.
 *
 * 1. Each edge gets a weight: predicate weight for the intent × truth
 *    (`decayWorkspaceSignal`) × authority × recency × hub penalty.
 * 2. Personalized PageRank (power iteration) runs on the explored subgraph.
 *    The seeds and the query hits make the restart vector.
 * 3. Score: `ppr^(1 − queryWeight) × (0.1 + queryMatch)^queryWeight`.
 * 4. MMR diversity selects the results, and the path with the highest weight
 *    product (Dijkstra on −ln w) explains each result.
 *
 * The signal model comes from PR #350 `retrievalScore.ts` (ADR-040): a
 * weighted product of signals, each with a floor, so that one weak signal
 * lowers a unit but does not remove it. A weight of 0 turns a signal off.
 * The graph eval tunes the start values.
 */
import {
  combineWorkspaceSignals,
  decayWorkspaceSignal,
} from "./claim-confidence.js"

export const RELEVANCE_INTENTS = [
  "general",
  "why",
  "ownership",
  "change",
  "dependencies",
  "structure",
] as const

export type RelevanceIntent = (typeof RELEVANCE_INTENTS)[number]

/** One node of the explored subgraph. */
export type RelevanceNode = {
  id: string
  kind: string | null
  /**
   * Stored raw signal count of the node in the projection. The walk can
   * return fewer edges; the hub penalty uses this value. Null: no penalty.
   */
  degree: number | null
  /** Status of a decision (`accepted`, `superseded`, …). */
  status?: string | null
  /** Review decision of a pull request (`APPROVED`, …). */
  reviewDecision?: string | null
  /** Date of an event unit: merge date of a pull request, start of a thread. */
  eventDate?: string | null
}

/** One raw signal (claim) of an edge, as the walk returns it. */
export type RelevanceSignal = {
  from: string
  to: string
  predicate: string
  /** Stored c_max of the signal. */
  confidence: number | null
  validFrom: string | null
  validTo: string | null
  source: string | null
}

export type RelevanceSignalWeights = {
  /** Decayed confidence of the edge. */
  truth: number
  /** Decision status and pull request review decision. */
  authority: number
  /** Age of an event. */
  recency: number
}

export type RelevanceOptions = {
  intent?: RelevanceIntent
  /** Replaces single predicate weights of the intent. 0 removes the edges. */
  predicateWeights?: Readonly<Record<string, number>>
  /** Replaces single signal weights of the intent. */
  signalWeights?: Partial<RelevanceSignalWeights>
  /** The walk direction along the stored edges. Default `both`. */
  direction?: "out" | "in" | "both"
  /** Restart probability of the walk. Default 0.15. */
  restart?: number
  /** Share of the query in the score and the restart vector. Default 0.5. */
  queryWeight?: number
  /** β of the hub penalty `degree^-β`. The intent sets the default. */
  hubPenalty?: number
  /** Half-life of an event. Default 90 days. */
  recencyHalfLifeDays?: number
  /** λ of MMR: 0 ranks by score only. Default 0.3. */
  diversity?: number
  maxPerKind?: number
  includeSeeds?: boolean
  /** Number of results. Default 100. */
  limit?: number
  /** Time for decay and recency (`validAt`). Default: the current time. */
  now?: Date
}

export type RelevancePathStep = {
  /** The stored direction of the edge, also on a reverse step. */
  from: string
  to: string
  predicate: string
  weight: number
}

export type RelatedResult = {
  id: string
  kind: string | null
  score: number
  ppr: number
  /** The query score of the unit divided by the top score; 0 for a miss. */
  queryMatch: number
  /** The highest-weight path from a seed; empty for a seed or a lone hit. */
  path: RelevancePathStep[]
}

type IntentPreset = {
  predicates: Readonly<Record<string, number>>
  signals: RelevanceSignalWeights
  hubPenalty: number
  /** A question about history: a decision status does not lower it. */
  history: boolean
}

/** No signal goes below this value, so no unit is removed by one signal. */
const SIGNAL_FLOOR = 0.05

/**
 * Every weight starts at 1 (a log-linear model, Metzler and Croft), except
 * recency: a recency prior helps only questions about time (Li and Croft).
 */
const BASE_SIGNALS: RelevanceSignalWeights = {
  truth: 1,
  authority: 1,
  recency: 0,
}

/** degree^-0.5, as in HippoRAG and RP3β: 1 for a leaf, 0.1 for 100 signals. */
const BASE_HUB_PENALTY = 0.5

/** The file change types share one predicate weight; their `validFrom` is the merge date. */
const CHANGE_PREDICATES = ["CHANGED", "ADDED", "MODIFIED", "REMOVED", "RENAMED"]
const DATED_PREDICATES: ReadonlySet<string> = new Set([
  ...CHANGE_PREDICATES,
  "TARGETS",
])

const DEPENDENCY_PREDICATES = [
  "DEPENDS_ON",
  "CONSUMES_API",
  "CONSUMES_FROM",
  "READS_FROM",
  "USES_LIBRARY",
]

const STRUCTURAL_PREDICATES = [
  ...DEPENDENCY_PREDICATES,
  "EXPOSES_API",
  "HAS_OPERATION",
  "PRODUCES_TO",
  "WRITES_TO",
  "RUNS_ON",
]

function weightAll(predicates: readonly string[], weight: number) {
  return Object.fromEntries(predicates.map((predicate) => [predicate, weight]))
}

/** The turns of PR #350 become predicate weights. */
export const INTENT_PRESETS: Readonly<Record<RelevanceIntent, IntentPreset>> =
  {
    general: {
      predicates: {},
      signals: BASE_SIGNALS,
      hubPenalty: BASE_HUB_PENALTY,
      history: false,
    },
    // A team that owns many services and issues is still the owner.
    ownership: {
      predicates: { OWNS: 3 },
      signals: BASE_SIGNALS,
      hubPenalty: 0,
      history: false,
    },
    // The decisions come before the files that declare them.
    why: {
      predicates: { INFLUENCES: 3, SUPERSEDES: 2 },
      signals: BASE_SIGNALS,
      hubPenalty: BASE_HUB_PENALTY,
      history: true,
    },
    // A recent large change is often the answer, so no hub penalty.
    change: {
      predicates: {
        ...weightAll(CHANGE_PREDICATES, 3),
        TARGETS: 3,
        REFERENCES: 2,
      },
      signals: { ...BASE_SIGNALS, recency: 1 },
      hubPenalty: 0,
      history: true,
    },
    dependencies: {
      predicates: weightAll(DEPENDENCY_PREDICATES, 3),
      signals: BASE_SIGNALS,
      hubPenalty: BASE_HUB_PENALTY,
      history: false,
    },
    structure: {
      predicates: weightAll(STRUCTURAL_PREDICATES, 3),
      signals: BASE_SIGNALS,
      hubPenalty: BASE_HUB_PENALTY,
      history: false,
    },
  }

/**
 * ADR lifecycle (Nygard, MADR): in force, then undeclared, then not yet in
 * force, then no longer in force (ADR-036).
 */
const DECISION_STATUS_FACTORS: Readonly<Record<string, number>> = {
  accepted: 1,
  proposed: 0.6,
  draft: 0.6,
  deprecated: 0.3,
  superseded: 0.3,
  rejected: 0.3,
}
const UNDECLARED_DECISION_FACTOR = 0.9

/** Many teams merge without a formal review, so no review costs less than a change request. */
const REVIEW_DECISION_FACTORS: Readonly<Record<string, number>> = {
  APPROVED: 1,
  CHANGES_REQUESTED: 0.6,
}
const UNREVIEWED_FACTOR = 0.8

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90
/** An old event still counts for this much. */
const RECENCY_FLOOR = 0.1
/** An event with no date counts as one half-life old. */
const UNDATED_RECENCY = 0.5

/** A unit that the query did not find still has this query factor. */
const QUERY_MATCH_BASE = 0.1

const DAY_MS = 86_400_000
const PPR_TOLERANCE = 1e-12
const PPR_MAX_ITERATIONS = 500

/** `PullRequest`, `pull-request` and `pull_request` are one kind. */
function kindKey(kind: string | null | undefined): string {
  return (kind ?? "").toLowerCase().replace(/[^a-z]/g, "")
}

function authority(node: RelevanceNode, history: boolean): number {
  const kind = kindKey(node.kind)
  if (kind === "decision") {
    if (history) return 1
    return (
      DECISION_STATUS_FACTORS[node.status?.trim().toLowerCase() ?? ""] ??
      UNDECLARED_DECISION_FACTOR
    )
  }
  if (kind === "pullrequest") {
    return (
      REVIEW_DECISION_FACTORS[node.reviewDecision?.trim().toUpperCase() ?? ""] ??
      UNREVIEWED_FACTOR
    )
  }
  return 1
}

/**
 * max(0.1, 2^(-age / half-life)) for events: change edges (from their
 * `validFrom`), pull requests and threads (from `eventDate`). State facts do
 * not decay here: their validity window and decay control them.
 */
function recency(
  predicate: string,
  edgeValidFrom: string | null,
  node: RelevanceNode,
  halfLifeDays: number,
  now: Date,
): number {
  const dated = DATED_PREDICATES.has(predicate)
  const kind = kindKey(node.kind)
  if (!dated && kind !== "pullrequest" && kind !== "thread") return 1
  const date = Date.parse((dated ? edgeValidFrom : null) ?? node.eventDate ?? "")
  if (Number.isNaN(date)) return UNDATED_RECENCY
  const ageDays = Math.max(0, now.getTime() - date) / DAY_MS
  return Math.max(RECENCY_FLOOR, 0.5 ** (ageDays / halfLifeDays))
}

/** Π max(sᵢ, floor)^wᵢ, with no factor for a weight of 0. */
function weightedProduct(
  values: ReadonlyArray<[signal: number, weight: number]>,
): number {
  let product = 1
  for (const [signal, weight] of values) {
    if (weight === 0) continue
    product *= Math.max(SIGNAL_FLOOR, signal) ** weight
  }
  return product
}

type StoredEdge = {
  from: string
  to: string
  predicate: string
  truth: number
  /** The latest `validFrom` of the live signals. */
  validFrom: string | null
}

/** One edge for each (from, to, predicate), with the damped combination of its live signals. */
function combineEdges(
  signals: readonly RelevanceSignal[],
  nodeIds: ReadonlySet<string>,
  now: Date,
): StoredEdge[] {
  const grouped = new Map<string, { edge: StoredEdge; energies: number[] }>()
  for (const signal of signals) {
    if (!nodeIds.has(signal.from) || !nodeIds.has(signal.to)) continue
    if (signal.from === signal.to) continue
    const energy = decayWorkspaceSignal({ ...signal, now })
    if (energy <= 0) continue
    const predicate = signal.predicate.toUpperCase()
    const key = `${signal.from}\0${signal.to}\0${predicate}`
    const group = grouped.get(key) ?? {
      edge: {
        from: signal.from,
        to: signal.to,
        predicate,
        truth: 0,
        validFrom: null,
      },
      energies: [],
    }
    group.energies.push(energy)
    if (
      signal.validFrom &&
      (!group.edge.validFrom || signal.validFrom > group.edge.validFrom)
    ) {
      group.edge.validFrom = signal.validFrom
    }
    grouped.set(key, group)
  }
  return [...grouped.values()].map(({ edge, energies }) => ({
    ...edge,
    truth: combineWorkspaceSignals(energies),
  }))
}

/** Query scores by node id, each divided by the top score (RRF is at most about 0.033). */
function normalizeQueryHits(
  hits: ReadonlyArray<{ id: string; score: number }>,
  nodeIds: ReadonlySet<string>,
): Map<string, number> {
  const live = hits.filter(
    (hit) => nodeIds.has(hit.id) && Number.isFinite(hit.score) && hit.score > 0,
  )
  const top = Math.max(0, ...live.map((hit) => hit.score))
  const match = new Map<string, number>()
  for (const hit of live) {
    match.set(hit.id, Math.max(match.get(hit.id) ?? 0, hit.score / top))
  }
  return match
}

type Step = { to: number; weight: number; edge: StoredEdge }

function personalizedPageRank(
  out: ReadonlyArray<readonly Step[]>,
  restartVector: Float64Array,
  restart: number,
): Float64Array {
  const size = restartVector.length
  const totals = out.map((steps) =>
    steps.reduce((sum, step) => sum + step.weight, 0),
  )
  let rank = Float64Array.from(restartVector)
  for (let iteration = 0; iteration < PPR_MAX_ITERATIONS; iteration += 1) {
    const next = new Float64Array(size)
    let dangling = 0
    for (let from = 0; from < size; from += 1) {
      const mass = rank[from] ?? 0
      if (mass === 0) continue
      const total = totals[from] ?? 0
      if (total === 0) {
        dangling += mass
        continue
      }
      for (const step of out[from] ?? []) {
        next[step.to] = (next[step.to] ?? 0) + (mass * step.weight) / total
      }
    }
    let change = 0
    for (let index = 0; index < size; index += 1) {
      const value =
        (restart + (1 - restart) * dangling) * (restartVector[index] ?? 0) +
        (1 - restart) * (next[index] ?? 0)
      change += Math.abs(value - (rank[index] ?? 0))
      next[index] = value
    }
    rank = next
    if (change < PPR_TOLERANCE) break
  }
  return rank
}

/** Dijkstra on −ln w from every seed: the path with the highest weight product. */
function bestPaths(
  out: ReadonlyArray<readonly Step[]>,
  sources: readonly number[],
): Array<Step[] | null> {
  const size = out.length
  const cost = new Float64Array(size).fill(Number.POSITIVE_INFINITY)
  const previous: Array<{ from: number; step: Step } | null> = Array(size).fill(
    null,
  )
  const heap = new MinHeap()
  for (const source of sources) {
    cost[source] = 0
    heap.push(source, 0)
  }
  const done = new Uint8Array(size)
  for (let top = heap.pop(); top; top = heap.pop()) {
    const [from] = top
    if (done[from]) continue
    done[from] = 1
    for (const step of out[from] ?? []) {
      const candidate = (cost[from] ?? 0) - Math.log(step.weight)
      if (candidate < (cost[step.to] ?? Number.POSITIVE_INFINITY)) {
        cost[step.to] = candidate
        previous[step.to] = { from, step }
        heap.push(step.to, candidate)
      }
    }
  }
  return Array.from({ length: size }, (_, target) => {
    if (!Number.isFinite(cost[target] ?? Number.POSITIVE_INFINITY)) return null
    const path: Step[] = []
    for (let at = previous[target]; at; at = previous[at.from]) {
      path.unshift(at.step)
    }
    return path
  })
}

class MinHeap {
  private readonly items: Array<[node: number, cost: number]> = []

  push(node: number, cost: number) {
    const items = this.items
    items.push([node, cost])
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if ((items[parent]?.[1] ?? 0) <= cost) break
      ;[items[parent], items[index]] = [
        items[index] as [number, number],
        items[parent] as [number, number],
      ]
      index = parent
    }
  }

  pop(): [number, number] | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (!top || !last || items.length === 0) return top
    items[0] = last
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if ((items[left]?.[1] ?? Infinity) < (items[smallest]?.[1] ?? Infinity))
        smallest = left
      if ((items[right]?.[1] ?? Infinity) < (items[smallest]?.[1] ?? Infinity))
        smallest = right
      if (smallest === index) break
      ;[items[smallest], items[index]] = [
        items[index] as [number, number],
        items[smallest] as [number, number],
      ]
      index = smallest
    }
    return top
  }
}

/** Half kind overlap, half Jaccard overlap of the neighbors that are not seeds. */
function similarity(
  a: { kind: string; neighbors: ReadonlySet<number> },
  b: { kind: string; neighbors: ReadonlySet<number> },
): number {
  const kind = a.kind === b.kind ? 1 : 0
  let shared = 0
  for (const neighbor of a.neighbors) if (b.neighbors.has(neighbor)) shared += 1
  const union = a.neighbors.size + b.neighbors.size - shared
  return 0.5 * kind + 0.5 * (union === 0 ? 0 : shared / union)
}

/**
 * Ranks the units of the explored subgraph for one `get_related` call. Only
 * the edges in `signals` enter the walk; `degree` comes from the projection.
 */
export function rankRelated(input: {
  nodes: readonly RelevanceNode[]
  signals: readonly RelevanceSignal[]
  seeds: readonly string[]
  /** Hybrid search scores of the explored units (reciprocal rank fusion). */
  queryHits?: ReadonlyArray<{ id: string; score: number }>
  options?: RelevanceOptions
}): RelatedResult[] {
  const options = input.options ?? {}
  const preset = INTENT_PRESETS[options.intent ?? "general"]
  const now = options.now ?? new Date()
  const direction = options.direction ?? "both"
  const restart = options.restart ?? 0.15
  const hubPenalty = options.hubPenalty ?? preset.hubPenalty
  const halfLifeDays =
    options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS
  const signalWeights = { ...preset.signals, ...options.signalWeights }
  const predicateWeights: Record<string, number> = { ...preset.predicates }
  for (const [predicate, weight] of Object.entries(
    options.predicateWeights ?? {},
  )) {
    predicateWeights[predicate.toUpperCase()] = weight
  }
  // A constant factor does not change the walk, and it keeps each weight in
  // (0, 1], so that −ln w is not negative.
  const predicateScale = Math.max(1, ...Object.values(predicateWeights))

  const nodes = [...new Map(input.nodes.map((node) => [node.id, node])).values()]
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
  const nodeIds = new Set(indexOf.keys())
  const seeds = [
    ...new Set(input.seeds.flatMap((id) => indexOf.get(id) ?? [])),
  ]
  if (seeds.length === 0) return []
  const seedSet = new Set(seeds)

  const queryWeight = options.queryWeight ?? 0.5
  const match =
    queryWeight > 0
      ? normalizeQueryHits(input.queryHits ?? [], nodeIds)
      : new Map<string, number>()
  const hits = new Set(
    [...match.keys()].flatMap((id) => indexOf.get(id) ?? []),
  )
  const effectiveQueryWeight = match.size > 0 ? queryWeight : 0

  const stepWeight = (edge: StoredEdge, reached: number): number => {
    const node = nodes[reached] as RelevanceNode
    const predicate = predicateWeights[edge.predicate] ?? 1
    if (predicate <= 0) return 0
    const named = seedSet.has(reached) || hits.has(reached)
    const specificity =
      named || hubPenalty === 0 || node.degree === null
        ? 1
        : Math.max(SIGNAL_FLOOR, Math.max(1, node.degree) ** -hubPenalty)
    return (
      (predicate / predicateScale) *
      specificity *
      weightedProduct([
        [edge.truth, signalWeights.truth],
        [authority(node, preset.history), signalWeights.authority],
        [
          recency(edge.predicate, edge.validFrom, node, halfLifeDays, now),
          signalWeights.recency,
        ],
      ])
    )
  }

  const out: Step[][] = nodes.map(() => [])
  const neighbors = nodes.map(() => new Set<number>())
  for (const edge of combineEdges(input.signals, nodeIds, now)) {
    const from = indexOf.get(edge.from) as number
    const to = indexOf.get(edge.to) as number
    const forward = direction !== "in" ? stepWeight(edge, to) : 0
    const backward = direction !== "out" ? stepWeight(edge, from) : 0
    if (forward > 0) out[from]?.push({ to, weight: forward, edge })
    if (backward > 0) out[to]?.push({ to: from, weight: backward, edge })
    if (forward > 0 || backward > 0) {
      if (!seedSet.has(to)) neighbors[from]?.add(to)
      if (!seedSet.has(from)) neighbors[to]?.add(from)
    }
  }

  const restartVector = new Float64Array(nodes.length)
  for (const seed of seeds) restartVector[seed] = 1 / seeds.length
  const matchTotal = [...match.values()].reduce((sum, value) => sum + value, 0)
  for (const [id, value] of match) {
    const index = indexOf.get(id) as number
    restartVector[index] =
      (restartVector[index] ?? 0) + (effectiveQueryWeight * value) / matchTotal
  }
  const restartTotal = restartVector.reduce((sum, value) => sum + value, 0)
  for (let index = 0; index < restartVector.length; index += 1) {
    restartVector[index] = (restartVector[index] ?? 0) / restartTotal
  }

  const ppr = personalizedPageRank(out, restartVector, restart)
  const paths = bestPaths(out, seeds)

  const candidates = nodes
    .map((node, index) => {
      const nodePpr = ppr[index] ?? 0
      const queryMatch = match.get(node.id) ?? 0
      const score =
        effectiveQueryWeight === 0
          ? nodePpr
          : nodePpr ** (1 - effectiveQueryWeight) *
            (QUERY_MATCH_BASE + queryMatch) ** effectiveQueryWeight
      return { node, index, ppr: nodePpr, queryMatch, score }
    })
    .filter(
      (candidate) =>
        candidate.ppr > 0 &&
        (options.includeSeeds || !seedSet.has(candidate.index)),
    )
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))

  const selected = selectDiverse(candidates, {
    diversity: options.diversity ?? 0.3,
    maxPerKind: options.maxPerKind,
    limit: options.limit ?? 100,
    neighbors,
  })
  return selected.map((candidate) => ({
    id: candidate.node.id,
    kind: candidate.node.kind,
    score: candidate.score,
    ppr: candidate.ppr,
    queryMatch: candidate.queryMatch,
    path: (paths[candidate.index] ?? []).map((step) => ({
      from: step.edge.from,
      to: step.edge.to,
      predicate: step.edge.predicate,
      weight: step.weight,
    })),
  }))
}

/** Greedy MMR: (1 − λ) × relevance − λ × the highest similarity to a selected unit. */
function selectDiverse<
  T extends { node: RelevanceNode; index: number; score: number },
>(
  ranked: readonly T[],
  options: {
    diversity: number
    maxPerKind: number | undefined
    limit: number
    neighbors: ReadonlyArray<ReadonlySet<number>>
  },
): T[] {
  const { diversity, maxPerKind, limit } = options
  const perKind = new Map<string, number>()
  const kindFull = (candidate: T) =>
    maxPerKind !== undefined &&
    (perKind.get(kindKey(candidate.node.kind)) ?? 0) >= maxPerKind
  const take = (candidate: T, into: T[]) => {
    const kind = kindKey(candidate.node.kind)
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1)
    into.push(candidate)
  }
  const selected: T[] = []
  if (diversity <= 0) {
    for (const candidate of ranked) {
      if (selected.length >= limit) break
      if (!kindFull(candidate)) take(candidate, selected)
    }
    return selected
  }
  const topScore = ranked[0]?.score ?? 0
  const profile = (candidate: T) => ({
    kind: kindKey(candidate.node.kind),
    neighbors: options.neighbors[candidate.index] ?? new Set<number>(),
  })
  const remaining = ranked.map((candidate) => ({ candidate, maxSimilarity: 0 }))
  while (selected.length < limit && remaining.length > 0) {
    let best = -1
    let bestValue = Number.NEGATIVE_INFINITY
    for (const [position, entry] of remaining.entries()) {
      if (kindFull(entry.candidate)) continue
      const relevance = topScore > 0 ? entry.candidate.score / topScore : 0
      const value =
        (1 - diversity) * relevance - diversity * entry.maxSimilarity
      if (value > bestValue) {
        bestValue = value
        best = position
      }
    }
    if (best < 0) break
    const [chosen] = remaining.splice(best, 1)
    if (!chosen) break
    take(chosen.candidate, selected)
    const chosenProfile = profile(chosen.candidate)
    for (const entry of remaining) {
      entry.maxSimilarity = Math.max(
        entry.maxSimilarity,
        similarity(profile(entry.candidate), chosenProfile),
      )
    }
  }
  return selected
}
