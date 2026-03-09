import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"

export type TraversalResult = {
  nodeIds: string[]
  edgeClaimIds: string[]
  depth: number
}

const MIN_DEPTH = 1
const MAX_DEPTH = 5

const EXTENSION_PREDICATES = [
  "RELATES_TO",
  "ABOUT",
  "MENTIONS",
  "ASSOCIATED_WITH",
  "INFLUENCES",
]

export type GraphTraversalOptions = {
  /** Max depth (default 3, clamped to 1-5) */
  maxDepth?: number
  /** Max number of paths to return (default 50) */
  limit?: number
  /** When set, filter edges to those valid at this time */
  validAt?: Date
  /** When true, only traverse edges with extension predicates (RELATES_TO, ABOUT, etc.) */
  useExtensionLayer?: boolean
}

/** Clamps depth to allowed range; Cypher does not support parameterized path length. */
function clampDepth(d: number): number {
  const n = Math.floor(Number(d))
  if (Number.isNaN(n) || n < MIN_DEPTH) return MIN_DEPTH
  if (n > MAX_DEPTH) return MAX_DEPTH
  return n
}

/**
 * Traverses the graph from a start node up to maxDepth.
 * Returns distinct node IDs and claim IDs encountered.
 * Uses parameterized Cypher and org filter for tenant isolation.
 * maxDepth is clamped to 1-5 (Cypher does not support parameterized path length).
 */
export async function graphTraversal(
  orgId: string,
  orgSlug: string,
  startId: string,
  options?: GraphTraversalOptions,
): Promise<TraversalResult> {
  const maxDepth = clampDepth(options?.maxDepth ?? 3)
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options?.limit ?? 50))))
  const validAt = options?.validAt
  const useExtensionLayer = options?.useExtensionLayer ?? false

  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()
    const validityFilter =
      validAt != null
        ? ` AND ALL(rel IN relationships(path) WHERE
             (rel.valid_from IS NULL AND rel.valid_to IS NULL)
             OR (rel.valid_from IS NULL AND rel.valid_to >= datetime($validAt))
             OR (rel.valid_to IS NULL AND rel.valid_from <= datetime($validAt))
             OR (rel.valid_from <= datetime($validAt) AND rel.valid_to >= datetime($validAt)))`
        : ""
    const extensionFilter = useExtensionLayer
      ? ` AND ALL(rel IN relationships(path) WHERE rel.predicate IN ['${EXTENSION_PREDICATES.join("','")}'])`
      : ""

    const params: Record<string, unknown> = { startId, orgId, limit }
    if (validAt != null) {
      params.validAt = validAt.toISOString()
    }

    const { records } = await driver.executeQuery(
      `MATCH path = (start)-[*1..${maxDepth}]-(n)
       WHERE start.id = $startId AND start.orgId = $orgId
         AND ALL(node IN nodes(path) WHERE node.orgId = $orgId)${validityFilter}${extensionFilter}
       WITH path
       LIMIT $limit
       WITH [node IN nodes(path) | node.id] AS nodeIds,
            [rel IN relationships(path) | rel.claim_id] AS claimIds
       RETURN nodeIds, [c IN claimIds WHERE c IS NOT NULL] AS edgeClaimIds`,
      params,
    )

    const allNodeIds = new Set<string>()
    const allClaimIds = new Set<string>()

    for (const r of records) {
      const nids = r?.get("nodeIds")
      const cids = r?.get("edgeClaimIds")
      if (Array.isArray(nids)) {
        for (const v of nids) {
          const id =
            v != null && typeof v === "object" && "toString" in v
              ? String((v as { toString: () => string }).toString())
              : String(v)
          if (id && id !== "undefined") allNodeIds.add(id)
        }
      }
      if (Array.isArray(cids)) {
        for (const v of cids) {
          if (typeof v === "string") allClaimIds.add(v)
        }
      }
    }

    return {
      nodeIds: [...allNodeIds],
      edgeClaimIds: [...allClaimIds],
      depth: maxDepth,
    }
  })
}
