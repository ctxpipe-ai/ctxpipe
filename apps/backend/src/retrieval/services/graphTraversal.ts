import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import {
  DECISION_STATUS_FACTORS,
  normalizeSearchHits,
  type QueryIntent,
  type RetrievalSignals,
  retrievalProfile,
  type SignalWeights,
  scoreEdge,
  turnGroup,
  UNDECLARED_DECISION_FACTOR,
} from "./retrievalScore.js"

/** What a reached node is, so the advisor can read it rather than an opaque id. */
export type TraversalNode = {
  id: string
  kind: string | null
  name: string | null
  status: string | null
  /**
   * The title of a PullRequest (its name is only `owner/repo#N`), at most 120
   * characters. Null for other kinds: their names already say what they are.
   */
  summary: string | null
}

/** A kept edge, with the score and the signals that ranked it. */
export type TraversalEdge = {
  claimId: string | null
  toId: string
  predicate: string
  score: number
  signals: RetrievalSignals
}

export type TraversalResult = {
  nodeIds: string[]
  /** The nodes in `nodeIds` that the walk read, the start node first */
  nodes: TraversalNode[]
  edgeClaimIds: string[]
  depth: number
  /** The kept edges in the order the walk kept them. For evaluation and traces only. */
  edges: TraversalEdge[]
}

const MIN_DEPTH = 1
const MAX_DEPTH = 5

/**
 * Reference, cause, ownership, provenance and change families (ADR-033).
 * With them, a "why" walk gets from a Service to the pull request that added
 * the ADR that shapes it: Service <-INFLUENCES Decision -DECLARED_IN-> File
 * <-ADDED PullRequest. A "what changed" walk gets from a Service to the pull
 * requests that changed it in one hop (CHANGED). Containment (PART_OF) and
 * code structure stay on the core walk.
 */
export const EXTENSION_TRAVERSAL_PREDICATES = [
  "REFERENCES",
  "MENTIONS",
  "INFLUENCES",
  "SUPERSEDES",
  "OWNS",
  "DECLARED_IN",
  "TARGETS",
  "CHANGED",
  "ADDED",
  "MODIFIED",
  "REMOVED",
  "RENAMED",
] as const

export type GraphTraversalOptions = {
  /** Max depth (default 3, clamped to 1-5) */
  maxDepth?: number
  /** Edges kept across all hops (default 50, max 100) */
  limit?: number
  /**
   * Only walk edges valid on this day (default today): valid_from <= day < valid_to.
   * Recency is measured from this day too.
   */
  validAt?: Date
  /**
   * When true, only walk {@link EXTENSION_TRAVERSAL_PREDICATES}: references,
   * mentions, decisions, supersession, ownership, where a Decision or
   * InstructionUnit is declared, and the pull requests that changed a File or
   * a package or target a Repository
   */
  useExtensionLayer?: boolean
  /**
   * The nodes that the search for the question found, with the search score
   * (any positive scale; a hit without a score counts as the top hit). A hit
   * ranks higher, by its score.
   */
  searchHits?: ReadonlyArray<{ id: string; score?: number }>
  /** The question. Its intent sets the turns of each relation family and the signal weights. */
  query?: string
  /** Replaces the intent of `query`. "general" gives every relation family one turn. */
  intent?: QueryIntent
  /** Replaces single signal weights of the intent. 0 switches a signal off. */
  weights?: Partial<SignalWeights>
}

export type HopEdge = {
  to: TraversalNode
  predicate: string
  claimId: string | null
  /** Path truth: the product of edge truths from the start node */
  trust: number
  /** The weighted product of the signals; the walk keeps the highest first */
  score: number
  signals: RetrievalSignals
  /** The edge's `valid_from`, or null when it is open-ended */
  validFrom: string | null
  /** True when `to` is a search hit */
  preferred: boolean
}

/** Projection writes "" for a missing property. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/** Bolt drivers return integers as objects with `toNumber()`. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return Number(value)
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber(): number }).toNumber()
  }
  return null
}

/** Clamps depth to allowed range. */
function clampDepth(d: number): number {
  const n = Math.floor(Number(d))
  if (Number.isNaN(n) || n < MIN_DEPTH) return MIN_DEPTH
  if (n > MAX_DEPTH) return MAX_DEPTH
  return n
}

/** Code-point order, the same order Cypher's ORDER BY gives strings. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The order of edges within a relation family: score, then search hits, then
 * the newest `valid_from` (open-ended last), then claim id. Claim ids are
 * base32 UUIDv7, but base32 digits sort before its letters as text, so claim
 * id order is not creation order. It is only a stable last tie-break.
 */
function byScore(a: HopEdge, b: HopEdge): number {
  return (
    b.score - a.score ||
    Number(b.preferred) - Number(a.preferred) ||
    compareText(b.validFrom ?? "", a.validFrom ?? "") ||
    compareText(a.claimId ?? "", b.claimId ?? "") ||
    compareText(a.to.id, b.to.id)
  )
}

/**
 * Takes the best edges of each relation family in turns, so one plentiful
 * type (e.g. file containment) cannot use the whole budget. In each round, a
 * family takes up to `turns[family]` edges (default 1, at least 1), so the
 * families that the question asks about go first and every family still
 * gets a turn. The change types (CHANGED, ADDED, MODIFIED, REMOVED, RENAMED)
 * are one family.
 */
export function pickRoundRobin(
  edges: HopEdge[],
  budget: number,
  turns: Readonly<Record<string, number>> = {},
): HopEdge[] {
  const byFamily = new Map<string, HopEdge[]>()
  for (const e of [...edges].sort(byScore)) {
    const family = turnGroup(e.predicate)
    const group = byFamily.get(family)
    if (group) group.push(e)
    else byFamily.set(family, [e])
  }

  const picked: HopEdge[] = []
  for (let round = 0; picked.length < budget; round++) {
    const batch = [...byFamily].flatMap(([family, group]) => {
      const take = Math.max(1, Math.floor(turns[family] ?? 1))
      return group.slice(round * take, (round + 1) * take)
    })
    if (batch.length === 0) break
    picked.push(...batch.slice(0, budget - picked.length))
  }
  return picked
}

/** Reads the node from the columns that start with `prefix`, for example `toKind`. */
function readNode(
  record: { get(key: string): unknown },
  prefix: string,
  id: string,
): TraversalNode {
  const kind = text(record.get(`${prefix}Kind`))
  return {
    id,
    kind,
    name: text(record.get(`${prefix}Name`)),
    status: text(record.get(`${prefix}Status`)),
    summary:
      kind === "PullRequest" ? text(record.get(`${prefix}Summary`)) : null,
  }
}

/**
 * The status factor of a reached Decision, as Cypher. Only the per-type
 * slice uses it, so that the slice keeps the candidates that the trust order
 * of ADR-035 puts first. The score applies the same table in TypeScript.
 */
const DECISION_STATUS_CASE = `CASE WHEN coalesce(b.kind, '') <> 'Decision' THEN 1.0 ${Object.entries(
  DECISION_STATUS_FACTORS,
)
  .map(([status, factor]) => `WHEN b.status = '${status}' THEN ${factor}`)
  .join(" ")} ELSE ${UNDECLARED_DECISION_FACTOR} END`

/**
 * Walks the graph from a start node one hop at a time, keeping at most `limit`
 * edges in total. Each hop fetches the best candidates of each relation type,
 * scores them from read-time signals (truth, authority, search, recency,
 * specificity; see `retrievalScore.ts`), and picks them with
 * {@link pickRoundRobin}, with the turns of the question's intent. So the
 * result does not depend on the order edges were written. Hops before the
 * last take at most half of what is left, so a hub cannot starve deeper hops;
 * budget left at the end goes to the best edges passed over on the way.
 * Uses parameterized Cypher and org filter for tenant isolation.
 */
export async function graphTraversal(
  orgId: string,
  orgSlug: string,
  startId: string,
  options?: GraphTraversalOptions,
): Promise<TraversalResult> {
  const maxDepth = clampDepth(options?.maxDepth ?? 3)
  const budget = Math.min(
    100,
    Math.max(1, Math.floor(Number(options?.limit ?? 50))),
  )
  const asOf = options?.validAt ?? new Date()
  const validDay = asOf.toISOString().slice(0, 10)
  const extensionFilter = options?.useExtensionLayer
    ? ` AND type(rel) IN ['${EXTENSION_TRAVERSAL_PREDICATES.join("','")}']`
    : ""
  const { weights, turns } = retrievalProfile({
    query: options?.query,
    intent: options?.intent,
    weights: options?.weights,
  })
  // With the search signal off, hits get no tie-break and no slot priority.
  const searchScores = normalizeSearchHits(
    weights.search === 0 ? [] : (options?.searchHits ?? []),
  )
  const searchIds = [...searchScores.keys()]

  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()
    const nodeIds = new Set([startId])
    const nodes: TraversalNode[] = []
    const edgeClaimIds: string[] = []
    const kept: TraversalEdge[] = []
    const passedOver: HopEdge[] = []
    let frontier = [{ id: startId, trust: 1 }]
    let remaining = budget

    const keep = (picked: HopEdge[]) => {
      remaining -= picked.length
      const reached: typeof frontier = []
      for (const e of picked) {
        if (e.claimId) edgeClaimIds.push(e.claimId)
        kept.push({
          claimId: e.claimId,
          toId: e.to.id,
          predicate: e.predicate,
          score: e.score,
          signals: e.signals,
        })
        if (nodeIds.has(e.to.id)) continue
        nodeIds.add(e.to.id)
        nodes.push(e.to)
        reached.push({ id: e.to.id, trust: e.trust })
      }
      return reached
    }

    for (let hop = 0; hop < maxDepth; hop++) {
      if (frontier.length === 0 || remaining === 0) break

      // Node ids are not indexed: find the frontier in one scan rather than one
      // scan per frontier node. Validity is stored as ISO strings with "" for
      // open-ended, and not every provider has datetime(), so compare days.
      // The per-type slice is wider than the hop can keep, so that the score
      // can reorder it. The slice keeps search hits first (there are few),
      // then the trust order of ADR-035 (path truth times edge confidence
      // times decision status), then more evidence, then the newest
      // valid_from.
      // On the first hop the frontier is the start node only, so grouping by
      // it too does not change the groups, and it gives the start node's
      // columns without a second scan.
      const atStart = hop === 0
      const { records } = await driver.executeQuery(
        `MATCH (a) WHERE a.id IN $frontierIds AND a.orgId = $orgId
         WITH a
         UNWIND $frontier AS f
         WITH a, f WHERE f.id = a.id
         MATCH (a)-[rel]-(b)
         WHERE b.orgId = $orgId AND NOT b.id IN $visited
           AND (coalesce(rel.valid_from, '') = '' OR substring(rel.valid_from, 0, 10) <= $validDay)
           AND (coalesce(rel.valid_to, '') = '' OR substring(rel.valid_to, 0, 10) > $validDay)${extensionFilter}
         WITH a, b, rel, f.trust AS fromTrust,
              f.trust * coalesce(rel.aggregate_confidence, 0.5) * ${DECISION_STATUS_CASE} AS trust
         WITH a, b, rel, fromTrust, trust, coalesce(rel.valid_from, '') AS validFrom,
              coalesce(rel.source_count, 1) AS sources,
              CASE WHEN b.id IN $searchIds THEN 0 ELSE 1 END AS searchRank
         ORDER BY searchRank, trust DESC, sources DESC, validFrom DESC, rel.claim_id
         WITH ${atStart ? "a, " : ""}type(rel) AS predicate,
              collect({ toId: b.id, kind: b.kind, name: b.name, status: b.status,
                        summary: substring(coalesce(b.summary, ''), 0, 120),
                        reviewDecision: b.review_decision, mergedAt: b.merged_at,
                        capturedAt: b.captured_at, claimId: rel.claim_id,
                        fromTrust: fromTrust, confidence: rel.aggregate_confidence,
                        sources: sources, validFrom: validFrom })[..toInteger($perType)] AS edges
         UNWIND edges AS e
         RETURN e.toId AS toId, e.kind AS toKind, e.name AS toName, e.status AS toStatus,
                e.summary AS toSummary, e.reviewDecision AS toReviewDecision,
                e.mergedAt AS toMergedAt, e.capturedAt AS toCapturedAt, predicate,
                e.claimId AS claimId, e.fromTrust AS fromTrust, e.confidence AS confidence,
                e.sources AS sourceCount, e.validFrom AS validFrom${
                  atStart
                    ? `, a.kind AS startKind, a.name AS startName, a.status AS startStatus,
                substring(coalesce(a.summary, ''), 0, 120) AS startSummary`
                    : ""
                }`,
        {
          orgId,
          frontier,
          frontierIds: frontier.map((f) => f.id),
          visited: [...nodeIds],
          validDay,
          perType: Math.min(200, Math.max(remaining * 4, 40)),
          searchIds,
        },
      )

      const [first] = records
      if (atStart && first) nodes.push(readNode(first, "start", startId))

      const rows = records.map((r) => ({
        record: r,
        to: readNode(r, "to", String(r.get("toId"))),
      }))
      // Specificity needs the degree of each reached node: one more query
      // per hop, over the candidate ids only.
      const degrees =
        weights.specificity === 0 || rows.length === 0
          ? new Map<string, number>()
          : await nodeDegrees(driver, orgId, [
              ...new Set(rows.map((row) => row.to.id)),
            ])

      const edges: HopEdge[] = rows.map(({ record: r, to }) => {
        const predicate = String(r.get("predicate"))
        const validFrom = text(r.get("validFrom"))
        const { truth, signals, score } = scoreEdge(
          {
            predicate,
            parentTruth: num(r.get("fromTrust")) ?? 1,
            confidence: num(r.get("confidence")),
            sourceCount: num(r.get("sourceCount")),
            validFrom,
            toKind: to.kind,
            toStatus: to.status,
            toReviewDecision: text(r.get("toReviewDecision")),
            toDate:
              to.kind === "PullRequest"
                ? text(r.get("toMergedAt"))
                : to.kind === "Thread"
                  ? text(r.get("toCapturedAt"))
                  : null,
            degree: degrees.get(to.id) ?? null,
            searchScore: searchScores.get(to.id),
          },
          weights,
          asOf,
        )
        return {
          to,
          predicate,
          claimId: text(r.get("claimId")),
          trust: truth,
          score,
          signals,
          validFrom,
          preferred: searchScores.has(to.id),
        }
      })

      const cap = hop === maxDepth - 1 ? remaining : Math.ceil(remaining / 2)
      const picked = pickRoundRobin(edges, cap, turns)
      const pickedSet = new Set(picked)
      passedOver.push(...edges.filter((e) => !pickedSet.has(e)))
      frontier = keep(picked)
    }

    if (remaining > 0) keep(pickRoundRobin(passedOver, remaining, turns))

    return {
      nodeIds: nodeIds.size > 1 ? [...nodeIds] : [],
      nodes: nodeIds.size > 1 ? nodes : [],
      edgeClaimIds,
      depth: maxDepth,
      edges: kept,
    }
  })
}

/** Edge count of each node, in one scan over the ids. */
async function nodeDegrees(
  driver: ReturnType<typeof getGraphClient>,
  orgId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const { records } = await driver.executeQuery(
    `MATCH (b) WHERE b.id IN $ids AND b.orgId = $orgId
     OPTIONAL MATCH (b)--(x)
     RETURN b.id AS id, count(x) AS degree`,
    { ids, orgId },
  )
  return new Map(
    records.map((r) => [String(r.get("id")), num(r.get("degree")) ?? 0]),
  )
}
