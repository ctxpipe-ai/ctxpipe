import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"

export type TraversalResult = {
  nodeIds: string[]
  edgeClaimIds: string[]
  depth: number
}

export type GraphTraversalOptions = {
  /** Max depth (default 3) */
  maxDepth?: number
  /** Max number of paths to return (default 50) */
  limit?: number
}

/**
 * Traverses the graph from a start node up to maxDepth.
 * Returns distinct node IDs and claim IDs encountered.
 * Uses parameterized Cypher and org filter for tenant isolation.
 */
export async function graphTraversal(
  orgId: string,
  orgSlug: string,
  startId: string,
  options?: GraphTraversalOptions,
): Promise<TraversalResult> {
  const maxDepth = options?.maxDepth ?? 3
  const limit = options?.limit ?? 50

  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()
    const { records } = await driver.executeQuery(
      `MATCH path = (start)-[*1..${maxDepth}]-(n)
       WHERE start.id = $startId AND start.orgId = $orgId
         AND ALL(node IN nodes(path) WHERE node.orgId = $orgId)
       WITH path
       LIMIT $limit
       WITH [node IN nodes(path) | node.id] AS nodeIds,
            [rel IN relationships(path) | rel.claim_id] AS claimIds
       RETURN nodeIds, [c IN claimIds WHERE c IS NOT NULL] AS edgeClaimIds`,
      { startId, orgId, limit },
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
