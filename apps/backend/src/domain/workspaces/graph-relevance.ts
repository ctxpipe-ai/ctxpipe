/**
 * Graph relevance for `get_related` (ADR-051 section 6). This module has no
 * I/O: the caller gives the explored subgraph, the seeds, and the query hits.
 *
 * 1. Each edge gets a weight: predicate weight for the intent × truth
 *    (`decayWorkspaceSignal`) × recency × hub penalty. The seeds and the query
 *    hits get no hub penalty.
 * 2. Personalized PageRank (power iteration) runs on the explored subgraph.
 *    The seeds and the query hits make the restart vector: `queryWeight` is
 *    the share of the query hits. The out-weights of a node add up to at most
 *    1, so a weak sole edge sends only a part of the mass along it; the rest
 *    returns to the restart vector.
 * 3. Score: `ppr^(1 − queryWeight) × (0.1 + queryMatch)^queryWeight`.
 * 4. MMR diversity selects the results, and the path with the highest weight
 *    product (Dijkstra on −ln w) explains each result. The path weight has no
 *    predicate weight, so the path does not depend on the intent.
 * 5. The units of an answer kind of the intent come first (`isAnswerKind`),
 *    together with the strong query hits (`STRONG_QUERY_MATCH`).
 *    The kind of a unit, not the predicate of its edge, tells what it
 *    answers, because Workspace claims have free-form predicates.
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
  "provenance",
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
}

/** One raw signal (claim) of an edge, as the walk returns it (`ExpandedEdge`). */
export type RelevanceSignal = {
  sourceId: string
  targetId: string
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
  /** Age of a change edge. */
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
  /** Half-life of a change edge. Default 90 days. */
  recencyHalfLifeDays?: number
  /** λ of MMR: 0 ranks by score only. The intent sets the default. */
  diversity?: number
  maxPerKind?: number
  /**
   * Kinds of the results. The walk still uses every node; `limit`,
   * `maxPerKind` and the diversity penalty see only these kinds. Empty or
   * unset: all kinds.
   */
  kinds?: readonly string[]
  /** Kinds that are never a result. The walk still uses their nodes. */
  excludeKinds?: readonly string[]
  includeSeeds?: boolean
  /** Number of results. Default 100. */
  limit?: number
  /** Time for decay and recency (`validAt`). Default: the current time. */
  now?: Date
  /**
   * A window instead of one instant: an edge counts when it was valid at some
   * point inside. Each signal decays at the end of the window, or just before
   * its own end when that is earlier. Replaces `now` for the decay only.
   */
  validBetween?: { from: Date; to: Date }
}

export type RelevancePathStep = {
  /** The stored direction of the edge, also on a reverse step. */
  from: string
  to: string
  predicate: string
  /** The strength of the edge, between 0 and 1, with no predicate weight. */
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
  /** True for a unit of an answer kind of the intent or a strong query hit. */
  answer: boolean
}

type IntentPreset = {
  /**
   * The edges that `get_related` walks when the caller gives no `predicates`.
   * No list walks all edges.
   */
  walk?: readonly string[]
  predicates: Readonly<Record<string, number>>
  signals: RelevanceSignalWeights
  hubPenalty: number
  /** λ of MMR. Default 0.3. */
  diversity?: number
  /**
   * The kinds of the units that answer the question (`kindKey` form). They
   * come before the other results. No list: every kind answers.
   */
  answers?: readonly string[]
}

/** No signal goes below this value, so no unit is removed by one signal. */
const SIGNAL_FLOOR = 0.05

/**
 * Every weight starts at 1 (a log-linear model, Metzler and Croft), except
 * recency: a recency prior helps only questions about time (Li and Croft).
 */
const BASE_SIGNALS: RelevanceSignalWeights = {
  truth: 1,
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

/** A service depends on the store that it writes to, as on the one it reads. */
const DEPENDENCY_PREDICATES = [
  "DEPENDS_ON",
  "CONSUMES_API",
  "CONSUMES_FROM",
  "READS_FROM",
  "WRITES_TO",
  "USES_LIBRARY",
]

const STRUCTURAL_PREDICATES = [
  ...DEPENDENCY_PREDICATES,
  "EXPOSES_API",
  "HAS_OPERATION",
  "PRODUCES_TO",
  "RUNS_ON",
]

/**
 * Workspace claims have free-form predicates, and hydrate turns each body
 * link into `LINKS_TO`. Every default walk also follows these edges.
 */
const LINK_PREDICATES = ["LINKS_TO", "REFERENCES", "MENTIONS"]

/**
 * The predicate of the edge from a unit to the `Source` unit that it came
 * from (ADR-050). A `Source` unit has one such edge from each of its units,
 * so it is a hub. The walk of all edges (also the fallback walk) does not
 * follow these edges (`expandWorkspaceGraph`). Only the `provenance` intent,
 * or `predicates` that name them, walk them.
 */
export const FROM_SOURCE_PREDICATE = "FROM_SOURCE"

const OWNER_KINDS = ["team", "person", "group"]
const DECISION_KINDS = ["decision", "incident"]
const CHANGE_KINDS = ["pullrequest", "commit", "change"]
const DEPENDENCY_KINDS = [
  "library",
  "database",
  "service",
  "api",
  "package",
  "queue",
  "stream",
]

function weightAll(predicates: readonly string[], weight: number) {
  return Object.fromEntries(predicates.map((predicate) => [predicate, weight]))
}

/**
 * The turns of PR #350 become predicate weights. Each intent except `general`
 * first walks only its own edges and the link edges: on an unscoped walk, a
 * unit with many edges of one predicate (pull requests, notes) hides its
 * owner and its decisions. When that walk finds fewer results than the
 * limit, or no unit of an answer kind of the intent, `get_related` adds the
 * results of a walk over all edges after them.
 */
export const INTENT_PRESETS: Readonly<Record<RelevanceIntent, IntentPreset>> = {
  // The question is not known, so the results spread over kinds: else the
  // many rules or notes of a unit fill the first page.
  general: {
    predicates: {},
    signals: BASE_SIGNALS,
    hubPenalty: BASE_HUB_PENALTY,
    diversity: 0.5,
    // The rules and the notes of a hub come after the units that answer
    // one of the questions.
    answers: [
      ...OWNER_KINDS,
      ...DECISION_KINDS,
      ...CHANGE_KINDS,
      ...DEPENDENCY_KINDS,
    ],
  },
  // A team that owns many services and issues is still the owner.
  ownership: {
    walk: ["OWNS", ...LINK_PREDICATES],
    predicates: { OWNS: 3 },
    signals: BASE_SIGNALS,
    hubPenalty: 0,
    answers: OWNER_KINDS,
  },
  // The decisions come before the files that declare them.
  // The walk also reaches the incidents, the rules, and the dependencies
  // around a unit, because a decision often shapes what the unit depends on.
  why: {
    walk: [
      "INFLUENCES",
      "SUPERSEDES",
      "DEPENDS_ON",
      "AFFECTS",
      "APPLIES_TO",
      "TRACKED_BY",
      ...LINK_PREDICATES,
    ],
    predicates: { INFLUENCES: 3, SUPERSEDES: 2 },
    signals: BASE_SIGNALS,
    hubPenalty: BASE_HUB_PENALTY,
    answers: DECISION_KINDS,
  },
  // The hub penalty keeps a shared file that many changes touch from
  // pulling unrelated changes into the results.
  change: {
    walk: [...CHANGE_PREDICATES, "TARGETS", ...LINK_PREDICATES],
    predicates: {
      ...weightAll(CHANGE_PREDICATES, 3),
      TARGETS: 3,
      REFERENCES: 2,
    },
    signals: { ...BASE_SIGNALS, recency: 1 },
    hubPenalty: BASE_HUB_PENALTY,
    answers: CHANGE_KINDS,
  },
  dependencies: {
    walk: [...DEPENDENCY_PREDICATES, ...LINK_PREDICATES],
    predicates: weightAll(DEPENDENCY_PREDICATES, 3),
    signals: BASE_SIGNALS,
    hubPenalty: BASE_HUB_PENALTY,
    answers: DEPENDENCY_KINDS,
  },
  structure: {
    walk: [...STRUCTURAL_PREDICATES, ...LINK_PREDICATES],
    predicates: weightAll(STRUCTURAL_PREDICATES, 3),
    signals: BASE_SIGNALS,
    hubPenalty: BASE_HUB_PENALTY,
  },
  // A source with many units is still the source of each of them.
  provenance: {
    walk: [FROM_SOURCE_PREDICATE, ...LINK_PREDICATES],
    predicates: { [FROM_SOURCE_PREDICATE]: 3 },
    signals: BASE_SIGNALS,
    hubPenalty: 0,
  },
}

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90
/** An old event still counts for this much. */
const RECENCY_FLOOR = 0.1
/** A change edge with no date counts as one half-life old. */
const UNDATED_RECENCY = 0.5

/** A unit that the query did not find still has this query factor. */
const QUERY_MATCH_BASE = 0.1

/**
 * A query hit with at least this share of the top query score ranks with the
 * answers of the intent. A weaker hit can be a loose semantic match.
 */
const STRONG_QUERY_MATCH = 0.5

const DAY_MS = 86_400_000
const PPR_TOLERANCE = 1e-12
const PPR_MAX_ITERATIONS = 500

/** `PullRequest`, `pull-request` and `pull_request` are one kind. */
function kindKey(kind: string | null | undefined): string {
  return (kind ?? "").toLowerCase().replace(/[^a-z]/g, "")
}

/** True when a unit of `kind` answers the question of `intent`. */
export function isAnswerKind(
  intent: RelevanceIntent,
  kind: string | null | undefined,
): boolean {
  const answers = INTENT_PRESETS[intent].answers
  return !answers || answers.includes(kindKey(kind))
}

/**
 * max(0.1, 2^(-age / half-life)) for a change edge, from its `validFrom`.
 * State facts do not decay here: their validity window and decay control them.
 */
function recency(
  predicate: string,
  edgeValidFrom: string | null,
  halfLifeDays: number,
  now: Date,
): number {
  if (!DATED_PREDICATES.has(predicate)) return 1
  const date = Date.parse(edgeValidFrom ?? "")
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * One edge for each (from, to, predicate), with the damped combination of its
 * live signals. The edges come in key order, so the input order has no effect.
 */
function combineEdges(
  signals: readonly RelevanceSignal[],
  nodeIds: ReadonlySet<string>,
  energyOf: (signal: RelevanceSignal) => number,
): StoredEdge[] {
  const grouped = new Map<string, { edge: StoredEdge; energies: number[] }>()
  for (const signal of signals) {
    if (!nodeIds.has(signal.sourceId) || !nodeIds.has(signal.targetId)) continue
    if (signal.sourceId === signal.targetId) continue
    const energy = energyOf(signal)
    if (energy <= 0) continue
    const predicate = signal.predicate.toUpperCase()
    const key = `${signal.sourceId}\0${signal.targetId}\0${predicate}`
    const group = grouped.get(key) ?? {
      edge: {
        from: signal.sourceId,
        to: signal.targetId,
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
  return [...grouped.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, { edge, energies }]) => ({
      ...edge,
      truth: combineWorkspaceSignals(energies.sort((a, b) => b - a)),
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

type Step = {
  to: number
  /** The weight in the walk, with the predicate weight. */
  weight: number
  /** The weight on the explanation path, with no predicate weight. */
  pathWeight: number
  edge: StoredEdge
}

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
      // The out-weights sum to at most 1: a weak sole edge keeps its
      // absolute weight, and the rest of the mass returns to the restart vector.
      const total = totals[from] ?? 0
      const scale = Math.max(total, 1)
      dangling += (mass * (scale - total)) / scale
      for (const step of out[from] ?? []) {
        next[step.to] = (next[step.to] ?? 0) + (mass * step.weight) / scale
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
  const previous: Array<{ from: number; step: Step } | null> =
    Array(size).fill(null)
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
      const candidate =
        (cost[from] ?? 0) - Math.log(Math.min(step.pathWeight, 1))
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
  const [small, large] =
    a.neighbors.size <= b.neighbors.size
      ? [a.neighbors, b.neighbors]
      : [b.neighbors, a.neighbors]
  let shared = 0
  for (const neighbor of small) if (large.has(neighbor)) shared += 1
  const union = a.neighbors.size + b.neighbors.size - shared
  return 0.5 * kind + 0.5 * (union === 0 ? 0 : shared / union)
}

const inUnitRange = (value: number) => value >= 0 && value <= 1
const isWeight = (value: number) => Number.isFinite(value) && value >= 0

function checkRange(
  name: string,
  value: number,
  valid: (value: number) => boolean,
) {
  if (!valid(value)) throw new RangeError(`${name} is out of range: ${value}`)
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
  const queryWeight = options.queryWeight ?? 0.5
  const diversity = options.diversity ?? preset.diversity ?? 0.3
  checkRange("restart", restart, (value) => value > 0 && value < 1)
  checkRange("queryWeight", queryWeight, inUnitRange)
  checkRange("diversity", diversity, inUnitRange)
  checkRange("hubPenalty", hubPenalty, isWeight)
  checkRange("signalWeights.truth", signalWeights.truth, isWeight)
  checkRange("signalWeights.recency", signalWeights.recency, isWeight)
  checkRange("recencyHalfLifeDays", halfLifeDays, (value) => value > 0)
  const window = options.validBetween
  if (window && !(window.from.getTime() <= window.to.getTime())) {
    throw new RangeError("validBetween must end after it starts")
  }
  const energyOf = (signal: RelevanceSignal): number => {
    if (!window) return decayWorkspaceSignal({ ...signal, now })
    const validTo = Date.parse(signal.validTo ?? "")
    if (validTo <= window.from.getTime()) return 0
    // A signal that ended inside the window decays at its end; `validTo`
    // itself is already outside its validity.
    const at = Math.min(window.to.getTime(), validTo - 1)
    return decayWorkspaceSignal({
      ...signal,
      now: new Date(Number.isNaN(at) ? window.to : at),
    })
  }
  const predicateWeights: Record<string, number> = { ...preset.predicates }
  for (const [predicate, weight] of Object.entries(
    options.predicateWeights ?? {},
  )) {
    if (Number.isFinite(weight) && weight >= 0) {
      predicateWeights[predicate.toUpperCase()] = weight
    }
  }
  // The walk weight of an edge is at most 1, so that the walk sends no more
  // than all of the mass along the edges of a node.
  const predicateScale = Math.max(1, ...Object.values(predicateWeights))

  // Sorted by id, so that the order of the input has no effect.
  const nodes = [
    ...new Map(input.nodes.map((node) => [node.id, node])).values(),
  ].sort((a, b) => compare(a.id, b.id))
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
  const nodeIds = new Set(indexOf.keys())
  const seeds = [
    ...new Set(input.seeds.flatMap((id) => indexOf.get(id) ?? [])),
  ].sort((a, b) => a - b)
  if (seeds.length === 0) return []
  const seedSet = new Set(seeds)

  const match =
    queryWeight > 0
      ? normalizeQueryHits(input.queryHits ?? [], nodeIds)
      : new Map<string, number>()
  const hits = new Set([...match.keys()].flatMap((id) => indexOf.get(id) ?? []))
  const effectiveQueryWeight = match.size > 0 ? queryWeight : 0

  // The strength of an edge into `reached`, with no predicate weight.
  const edgeStrength = (edge: StoredEdge, reached: number): number => {
    const node = nodes[reached] as RelevanceNode
    // A seed or a query hit is a unit that the caller named: no penalty.
    const named = seedSet.has(reached) || hits.has(reached)
    const specificity =
      named || hubPenalty === 0 || node.degree === null
        ? 1
        : Math.max(SIGNAL_FLOOR, Math.max(1, node.degree) ** -hubPenalty)
    return (
      specificity *
      weightedProduct([
        [edge.truth, signalWeights.truth],
        [
          recency(edge.predicate, edge.validFrom, halfLifeDays, now),
          signalWeights.recency,
        ],
      ])
    )
  }

  const out: Step[][] = nodes.map(() => [])
  const neighbors = nodes.map(() => new Set<number>())
  for (const edge of combineEdges(input.signals, nodeIds, energyOf)) {
    const predicate = predicateWeights[edge.predicate] ?? 1
    if (predicate <= 0) continue
    const from = indexOf.get(edge.from) as number
    const to = indexOf.get(edge.to) as number
    const step = (reached: number): Step => {
      const pathWeight = edgeStrength(edge, reached)
      return {
        to: reached,
        weight: (predicate / predicateScale) * pathWeight,
        pathWeight,
        edge,
      }
    }
    const forward = direction !== "in" ? step(to) : null
    const backward = direction !== "out" ? step(from) : null
    if (forward && forward.weight > 0) out[from]?.push(forward)
    if (backward && backward.weight > 0) out[to]?.push(backward)
    if ((forward?.weight ?? 0) > 0 || (backward?.weight ?? 0) > 0) {
      if (!seedSet.has(to)) neighbors[from]?.add(to)
      if (!seedSet.has(from)) neighbors[to]?.add(from)
    }
  }

  // `queryWeight` is the exact share of the restart mass that the query hits get.
  const restartVector = new Float64Array(nodes.length)
  for (const seed of seeds) {
    restartVector[seed] = (1 - effectiveQueryWeight) / seeds.length
  }
  const matchTotal = [...match.values()].reduce((sum, value) => sum + value, 0)
  for (const [id, value] of match) {
    const index = indexOf.get(id) as number
    restartVector[index] =
      (restartVector[index] ?? 0) + (effectiveQueryWeight * value) / matchTotal
  }

  const ppr = personalizedPageRank(out, restartVector, restart)
  const paths = bestPaths(out, seeds)

  const keptKinds = options.kinds?.length
    ? new Set(options.kinds.map(kindKey))
    : null
  const droppedKinds = new Set((options.excludeKinds ?? []).map(kindKey))
  const candidates = nodes
    .map((node, index) => {
      const nodePpr = ppr[index] ?? 0
      const queryMatch = match.get(node.id) ?? 0
      const score =
        effectiveQueryWeight === 0
          ? nodePpr
          : nodePpr ** (1 - effectiveQueryWeight) *
            (QUERY_MATCH_BASE + queryMatch) ** effectiveQueryWeight
      return {
        node,
        index,
        ppr: nodePpr,
        queryMatch,
        score,
      }
    })
    .filter(
      (candidate) =>
        candidate.ppr > 0 &&
        (options.includeSeeds || !seedSet.has(candidate.index)) &&
        (!keptKinds || keptKinds.has(kindKey(candidate.node.kind))) &&
        !droppedKinds.has(kindKey(candidate.node.kind)),
    )
    .sort((a, b) => b.score - a.score || compare(a.node.id, b.node.id))

  // For provenance, the sources of a seed (and the units of a Source seed)
  // come first. The other units of those sources come last, below the other
  // answers, so that they do not fill the results.
  const tierOf = (index: number) => {
    if (options.intent !== "provenance" || seedSet.has(index)) return 0
    const path = paths[index] ?? []
    const fromSource = path.every(
      (step) => step.edge.predicate === FROM_SOURCE_PREDICATE,
    )
    if (fromSource && path.length === 1) return 0
    return fromSource && path.length > 1 ? 2 : 1
  }
  const limit = options.limit ?? 100
  const intent = options.intent ?? "general"
  // One count per group: the answers and the other units each get maxPerKind.
  const selection = (perKind: Map<string, number>) => ({
    diversity,
    maxPerKind: options.maxPerKind,
    perKind,
    neighbors,
  })
  const answerSelection = selection(new Map())
  const otherSelection = selection(new Map())
  // The answers first, each group with its own MMR. A strong query hit also
  // counts as an answer: a query names a unit that the kinds of the intent
  // do not list, such as a runbook. In the answer group, the query factor of
  // the score puts a strong hit before an answer kind that the query missed.
  const isAnswer = (candidate: (typeof candidates)[number]) =>
    isAnswerKind(intent, candidate.node.kind) ||
    candidate.queryMatch >= STRONG_QUERY_MATCH
  const selected: Array<{
    candidate: (typeof candidates)[number]
    answer: boolean
  }> = []
  for (const tier of [0, 1, 2]) {
    if (selected.length >= limit) break
    const pool = candidates.filter(
      (candidate) => tierOf(candidate.index) === tier,
    )
    const answers = selectDiverse(pool.filter(isAnswer), {
      ...answerSelection,
      limit: limit - selected.length,
    })
    selected.push(...answers.map((candidate) => ({ candidate, answer: true })))
    selected.push(
      ...selectDiverse(
        pool.filter((candidate) => !isAnswer(candidate)),
        { ...otherSelection, limit: limit - selected.length },
      ).map((candidate) => ({ candidate, answer: false })),
    )
  }
  return selected.map(({ candidate, answer }) => ({
    id: candidate.node.id,
    kind: candidate.node.kind,
    score: candidate.score,
    ppr: candidate.ppr,
    queryMatch: candidate.queryMatch,
    path: (paths[candidate.index] ?? []).map((step) => ({
      from: step.edge.from,
      to: step.edge.to,
      predicate: step.edge.predicate,
      weight: step.pathWeight,
    })),
    answer,
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
    /** The count of selected units of each kind; the call adds to it. */
    perKind: Map<string, number>
    limit: number
    neighbors: ReadonlyArray<ReadonlySet<number>>
  },
): T[] {
  const { diversity, maxPerKind, limit, perKind } = options
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
  const chosenProfiles: Array<ReturnType<typeof profile>> = []
  // In score order. `seen` counts the selected units in `maxSimilarity`.
  const remaining = ranked.map((candidate) => ({
    candidate,
    profile: profile(candidate),
    maxSimilarity: 0,
    seen: 0,
  }))
  while (selected.length < limit && remaining.length > 0) {
    let best = -1
    let bestValue = Number.NEGATIVE_INFINITY
    for (const [position, entry] of remaining.entries()) {
      const relevance = topScore > 0 ? entry.candidate.score / topScore : 0
      // The value is at most (1 − λ) × relevance, and relevance only goes
      // down from here, so no later unit can win.
      if ((1 - diversity) * relevance <= bestValue) break
      if (kindFull(entry.candidate)) continue
      for (; entry.seen < chosenProfiles.length; entry.seen += 1) {
        entry.maxSimilarity = Math.max(
          entry.maxSimilarity,
          similarity(
            entry.profile,
            chosenProfiles[entry.seen] as typeof entry.profile,
          ),
        )
      }
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
    chosenProfiles.push(chosen.profile)
  }
  return selected
}
