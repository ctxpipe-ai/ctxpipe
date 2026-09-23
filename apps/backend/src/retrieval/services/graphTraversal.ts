import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"

/** What a reached node is, so the advisor can read it rather than an opaque id. */
export type TraversalNode = {
  id: string
  kind: string | null
  name: string | null
  status: string | null
}

export type TraversalResult = {
  nodeIds: string[]
  /** Reached nodes (not the start node) */
  nodes: TraversalNode[]
  edgeClaimIds: string[]
  depth: number
}

const MIN_DEPTH = 1
const MAX_DEPTH = 5

/** Reference, cause and ownership families (ADR-033); containment and change stay on the core walk. */
export const EXTENSION_TRAVERSAL_PREDICATES = [
  "REFERENCES",
  "MENTIONS",
  "INFLUENCES",
  "SUPERSEDES",
  "OWNS",
] as const

export type GraphTraversalOptions = {
  /** Max depth (default 3, clamped to 1-5) */
  maxDepth?: number
  /** Edges kept across all hops (default 50, max 100) */
  limit?: number
  /** Only walk edges valid on this day (default today): valid_from <= day < valid_to */
  validAt?: Date
  /** When true, only traverse reference / cause / ownership edges (REFERENCES, MENTIONS, INFLUENCES, SUPERSEDES, OWNS) */
  useExtensionLayer?: boolean
}

export type HopEdge = {
  toId: string
  predicate: string
  claimId: string | null
  /** Product of edge confidences from the start node, times decision status */
  trust: number
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

function byTrust(a: HopEdge, b: HopEdge): number {
  return (
    b.trust - a.trust ||
    (a.claimId ?? "").localeCompare(b.claimId ?? "") ||
    a.toId.localeCompare(b.toId)
  )
}

/**
 * Takes the most trusted edge of each relation type in turn, so one plentiful
 * type (e.g. file containment) cannot use the whole budget.
 */
export function pickRoundRobin(edges: HopEdge[], budget: number): HopEdge[] {
  const byType = new Map<string, HopEdge[]>()
  for (const e of [...edges].sort(byTrust)) {
    const group = byType.get(e.predicate)
    if (group) group.push(e)
    else byType.set(e.predicate, [e])
  }

  const picked: HopEdge[] = []
  for (let i = 0; picked.length < budget; i++) {
    const round = [...byType.values()].flatMap((group) => group[i] ?? [])
    if (round.length === 0) break
    picked.push(...round.slice(0, budget - picked.length))
  }
  return picked
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

  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()
    const nodeIds = new Set([startId])
    const nodes: TraversalNode[] = []
    const seen = new Map<string, TraversalNode>()
    const edgeClaimIds: string[] = []
    const passedOver: HopEdge[] = []
    let frontier = [{ id: startId, trust: 1 }]
    let remaining = budget

    const keep = (picked: HopEdge[]) => {
      remaining -= picked.length
      const reached: typeof frontier = []
      for (const e of picked) {
        if (e.claimId) edgeClaimIds.push(e.claimId)
        if (nodeIds.has(e.toId)) continue
        nodeIds.add(e.toId)
        const node = seen.get(e.toId)
        if (node) nodes.push(node)
        reached.push({ id: e.toId, trust: e.trust })
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
      const { records } = await driver.executeQuery(
        `MATCH (a) WHERE a.id IN $frontierIds AND a.orgId = $orgId
         WITH a
         UNWIND $frontier AS f
         WITH a, f WHERE f.id = a.id
         MATCH (a)-[rel]-(b)
         WHERE b.orgId = $orgId AND NOT b.id IN $visited
           AND (coalesce(rel.valid_from, '') = '' OR substring(rel.valid_from, 0, 10) <= $validDay)
           AND (coalesce(rel.valid_to, '') = '' OR substring(rel.valid_to, 0, 10) > $validDay)${extensionFilter}
         WITH b, rel, f.trust * coalesce(rel.aggregate_confidence, 0.5) *
              CASE
                WHEN coalesce(b.kind, '') <> 'Decision' OR b.status = 'accepted' THEN 1.0
                WHEN b.status IN ['proposed', 'draft'] THEN 0.6
                WHEN b.status IN ['deprecated', 'superseded', 'rejected'] THEN 0.3
                ELSE 0.9
              END AS trust
         ORDER BY trust DESC, rel.claim_id
         WITH type(rel) AS predicate,
              collect({ toId: b.id, kind: b.kind, name: b.name, status: b.status, claimId: rel.claim_id, trust: trust })[..toInteger($perType)] AS edges
         UNWIND edges AS e
         RETURN e.toId AS toId, e.kind AS kind, e.name AS name, e.status AS status,
                predicate, e.claimId AS claimId, e.trust AS trust`,
        {
          orgId,
          frontier,
          frontierIds: frontier.map((f) => f.id),
          visited: [...nodeIds],
          validDay,
          perType: remaining,
        },
      )

      const edges: HopEdge[] = records.map((r) => {
        const toId = String(r.get("toId"))
        seen.set(toId, {
          id: toId,
          kind: text(r.get("kind")),
          name: text(r.get("name")),
          status: text(r.get("status")),
        })
        return {
          toId,
          predicate: String(r.get("predicate")),
          claimId: text(r.get("claimId")),
          trust: Number(r.get("trust")),
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
      nodes,
      edgeClaimIds,
      depth: maxDepth,
    }
  })
}
