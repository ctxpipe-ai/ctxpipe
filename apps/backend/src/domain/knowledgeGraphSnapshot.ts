import { getGraphClient, withGraphClient } from "../platform/graph/client.js"

export type KnowledgeGraphNode = {
  id: string
  kind: string
  name: string | null
  summary: string | null
}

export type KnowledgeGraphEdge = {
  sourceId: string
  targetId: string
  predicate: string
  claimId: string | null
  lastObservedAt: string | null
}

export type KnowledgeGraphMetrics = {
  totalNodes: number
  totalEdges: number
  lastUpdatedAt: string | null
  nodesReturned: number
  edgesReturned: number
  truncated: boolean
}

export type KnowledgeGraphSnapshot = {
  metrics: KnowledgeGraphMetrics
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
}

const DEFAULT_NODE_LIMIT = 6_000
const DEFAULT_EDGE_LIMIT = 12_000

function rowString(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return null
}

/**
 * Reads the org-scoped graph (FalkorDB / Bolt) built by claim projection for UI exploration.
 *
 * Isolation is **graph/database name = orgId** via `withGraphClient` — this snapshot is not
 * reading Postgres directly. Do not add `MATCH (n {orgId: …})` here: older or partial
 * projections can omit that property while still living in the correct named graph, which
 * would otherwise yield zero rows and an empty UI.
 *
 * Applies limits so very large graphs do not blow up the browser payload.
 */
export async function getKnowledgeGraphSnapshot(
  orgId: string,
  orgSlug: string,
  opts?: { nodeLimit?: number; edgeLimit?: number },
): Promise<KnowledgeGraphSnapshot> {
  const nodeLimit = opts?.nodeLimit ?? DEFAULT_NODE_LIMIT
  const edgeLimit = opts?.edgeLimit ?? DEFAULT_EDGE_LIMIT

  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()

    const countN = await driver.executeQuery(`MATCH (n) RETURN count(n) AS c`)
    const countE = await driver.executeQuery(
      `MATCH ()-[r]->() RETURN count(r) AS c`,
    )
    const maxTs = await driver.executeQuery(
      `MATCH ()-[r]->() RETURN max(r.last_observed_at) AS maxTs`,
    )

    const totalNodes = Number(countN.records[0]?.get("c") ?? 0)
    const totalEdges = Number(countE.records[0]?.get("c") ?? 0)
    const lastRaw = maxTs.records[0]?.get("maxTs")
    const lastUpdatedAt =
      lastRaw instanceof Date ? lastRaw.toISOString() : rowString(lastRaw)

    const nodeRows = await driver.executeQuery(
      `MATCH (n)
       RETURN n.id AS id,
              coalesce(n.kind, 'Unknown') AS kind,
              n.name AS name,
              n.summary AS summary
       ORDER BY id
       LIMIT $nodeLimit`,
      { nodeLimit },
    )

    const nodes: KnowledgeGraphNode[] = nodeRows.records.map((rec) => ({
      id: String(rec.get("id") ?? ""),
      kind: String(rec.get("kind") ?? "Unknown"),
      name: rowString(rec.get("name")),
      summary: rowString(rec.get("summary")),
    }))

    const edgeRows = await driver.executeQuery(
      `MATCH (a)-[r]->(b)
       RETURN a.id AS sourceId,
              b.id AS targetId,
              type(r) AS predicate,
              r.claim_id AS claimId,
              r.last_observed_at AS lastObservedAt
       ORDER BY claimId, sourceId, targetId
       LIMIT $edgeLimit`,
      { edgeLimit },
    )

    const edges: KnowledgeGraphEdge[] = edgeRows.records.map((rec) => {
      const last = rec.get("lastObservedAt")
      const lastObservedAt =
        last instanceof Date ? last.toISOString() : rowString(last)
      return {
        sourceId: String(rec.get("sourceId") ?? ""),
        targetId: String(rec.get("targetId") ?? ""),
        predicate: String(rec.get("predicate") ?? ""),
        claimId: rowString(rec.get("claimId")),
        lastObservedAt,
      }
    })

    const truncated = totalNodes > nodes.length || totalEdges > edges.length

    return {
      metrics: {
        totalNodes,
        totalEdges,
        lastUpdatedAt,
        nodesReturned: nodes.length,
        edgesReturned: edges.length,
        truncated,
      },
      nodes,
      edges,
    }
  })
}
