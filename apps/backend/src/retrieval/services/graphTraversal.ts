import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"

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

export type TraversalResult = {
  nodeIds: string[]
  /** The nodes in `nodeIds` that the walk read, the start node first */
  nodes: TraversalNode[]
  edgeClaimIds: string[]
  depth: number
}

const MIN_DEPTH = 1
const MAX_DEPTH = 5

/**
 * Reference, cause, ownership, provenance and change families (ADR-033).
 * With them, a "why" walk gets from a Service to the pull request that added
 * the ADR that shapes it: Service <-INFLUENCES Decision -DECLARED_IN-> File
 * <-ADDED PullRequest. Containment (PART_OF) and code structure stay on the
 * core walk.
 */
export const EXTENSION_TRAVERSAL_PREDICATES = [
  "REFERENCES",
  "MENTIONS",
  "INFLUENCES",
  "SUPERSEDES",
  "OWNS",
  "DECLARED_IN",
  "TARGETS",
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
  /** Only walk edges valid on this day (default today): valid_from <= day < valid_to */
  validAt?: Date
  /**
   * When true, only walk {@link EXTENSION_TRAVERSAL_PREDICATES}: references,
   * mentions, decisions, supersession, ownership, where a Decision or
   * InstructionUnit is declared, and the pull requests that changed a File or
   * target a Repository
   */
  useExtensionLayer?: boolean
  /**
   * Node ids that the question's search found. At equal trust, an edge to one
   * of these nodes is kept before other edges of its relation type.
   */
  preferIds?: string[]
}

export type HopEdge = {
  to: TraversalNode
  predicate: string
  claimId: string | null
  /** Product of edge confidences from the start node, times decision status */
  trust: number
  /** The edge's `valid_from`, or null when it is open-ended */
  validFrom: string | null
  /** True when `to` is in `preferIds` */
  preferred: boolean
}

/** Projection writes "" for a missing property. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
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
 * The order of edges within a relation type, the same as the hop query's
 * ORDER BY: trust, then nodes the search found, then the newest `valid_from`
 * (open-ended last), then claim id. Claim ids are base32 UUIDv7, but base32
 * digits sort before its letters as text, so claim id order is not creation
 * order. It is only a stable last tie-break.
 */
function byTrust(a: HopEdge, b: HopEdge): number {
  return (
    b.trust - a.trust ||
    Number(b.preferred) - Number(a.preferred) ||
    compareText(b.validFrom ?? "", a.validFrom ?? "") ||
    compareText(a.claimId ?? "", b.claimId ?? "") ||
    compareText(a.to.id, b.to.id)
  )
}

/**
 * Takes the most trusted edge of each relation type in turn, so one plentiful
 * type (e.g. file containment) cannot use the whole budget. The four file
 * change types (ADDED, MODIFIED, REMOVED, RENAMED) are one family and share
 * one turn.
 */
export function pickRoundRobin(edges: HopEdge[], budget: number): HopEdge[] {
  const byFamily = new Map<string, HopEdge[]>()
  for (const e of [...edges].sort(byTrust)) {
    const family = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"].includes(
      e.predicate,
    )
      ? "CHANGED"
      : e.predicate
    const group = byFamily.get(family)
    if (group) group.push(e)
    else byFamily.set(family, [e])
  }

  const picked: HopEdge[] = []
  for (let i = 0; picked.length < budget; i++) {
    const round = [...byFamily.values()].flatMap((group) => group[i] ?? [])
    if (round.length === 0) break
    picked.push(...round.slice(0, budget - picked.length))
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
 * Walks the graph from a start node one hop at a time, keeping at most `limit`
 * edges in total. Each hop is picked by {@link pickRoundRobin}, so the result
 * does not depend on the order edges were written. Hops before the last take
 * at most half of what is left, so a hub cannot starve deeper hops; budget left
 * at the end goes to the best edges passed over on the way.
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
  const validDay = (options?.validAt ?? new Date()).toISOString().slice(0, 10)
  const extensionFilter = options?.useExtensionLayer
    ? ` AND type(rel) IN ['${EXTENSION_TRAVERSAL_PREDICATES.join("','")}']`
    : ""
  const preferIds = options?.preferIds ?? []
  const preferred = new Set(preferIds)

  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()
    const nodeIds = new Set([startId])
    const nodes: TraversalNode[] = []
    const edgeClaimIds: string[] = []
    const passedOver: HopEdge[] = []
    let frontier = [{ id: startId, trust: 1 }]
    let remaining = budget

    const keep = (picked: HopEdge[]) => {
      remaining -= picked.length
      const reached: typeof frontier = []
      for (const e of picked) {
        if (e.claimId) edgeClaimIds.push(e.claimId)
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
      // Decisions follow the ADR lifecycle (Nygard, MADR): in force, then
      // undeclared, then not yet in force, then no longer in force.
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
         WITH a, b, rel, f.trust * coalesce(rel.aggregate_confidence, 0.5) *
              CASE
                WHEN coalesce(b.kind, '') <> 'Decision' OR b.status = 'accepted' THEN 1.0
                WHEN b.status IN ['proposed', 'draft'] THEN 0.6
                WHEN b.status IN ['deprecated', 'superseded', 'rejected'] THEN 0.3
                ELSE 0.9
              END AS trust
         WITH a, b, rel, trust, coalesce(rel.valid_from, '') AS validFrom,
              CASE WHEN b.id IN $preferIds THEN 0 ELSE 1 END AS searchRank
         ORDER BY trust DESC, searchRank, validFrom DESC, rel.claim_id
         WITH ${atStart ? "a, " : ""}type(rel) AS predicate,
              collect({ toId: b.id, kind: b.kind, name: b.name, status: b.status,
                        summary: substring(coalesce(b.summary, ''), 0, 120),
                        claimId: rel.claim_id, trust: trust, validFrom: validFrom })[..toInteger($perType)] AS edges
         UNWIND edges AS e
         RETURN e.toId AS toId, e.kind AS toKind, e.name AS toName, e.status AS toStatus,
                e.summary AS toSummary, predicate, e.claimId AS claimId, e.trust AS trust,
                e.validFrom AS validFrom${
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
          perType: remaining,
          preferIds,
        },
      )

      const [first] = records
      if (atStart && first) nodes.push(readNode(first, "start", startId))

      const edges: HopEdge[] = records.map((r) => {
        const to = readNode(r, "to", String(r.get("toId")))
        return {
          to,
          predicate: String(r.get("predicate")),
          claimId: text(r.get("claimId")),
          trust: Number(r.get("trust")),
          validFrom: text(r.get("validFrom")),
          preferred: preferred.has(to.id),
        }
      })

      const cap = hop === maxDepth - 1 ? remaining : Math.ceil(remaining / 2)
      const picked = pickRoundRobin(edges, cap)
      const pickedSet = new Set(picked)
      passedOver.push(...edges.filter((e) => !pickedSet.has(e)))
      frontier = keep(picked)
    }

    if (remaining > 0) keep(pickRoundRobin(passedOver, remaining))

    return {
      nodeIds: nodeIds.size > 1 ? [...nodeIds] : [],
      nodes: nodeIds.size > 1 ? nodes : [],
      edgeClaimIds,
      depth: maxDepth,
    }
  })
}
