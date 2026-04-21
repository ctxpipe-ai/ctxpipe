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
  lastObservedAt: string | null
  confidence: number | null
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

const DEFAULT_NODE_LIMIT = 250_000
const DEFAULT_EDGE_LIMIT = 500_000

function rowString(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return null
}

function rowIsoString(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  return rowString(v)
}

/**
 * Reads the org-scoped FalkorDB graph built by claim projection.
 *
 * Isolation is via `withGraphClient` (graph/database name = orgId). Do NOT add
 * `MATCH (n {orgId: …})` filters — older projections may omit that property
 * while still living in the correct named graph, which would yield zero rows.
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

    // `max(r.last_observed_at)` previously ran here but degrades badly as the
    // graph grows (unindexed property scan across every edge — seen to hang on
    // 200k+ edge graphs). `lastUpdatedAt` is nullable in the payload; compute
    // it lazily from Postgres if the UI needs it.
    const [countN, countE, nodeRows, edgeRows] = await Promise.all([
      driver.executeQuery(`MATCH (n) RETURN count(n) AS c`),
      driver.executeQuery(`MATCH ()-[r]->() RETURN count(r) AS c`),
      driver.executeQuery(
        `MATCH (n)
         WHERE n.id IS NOT NULL
         RETURN n.id AS id,
                coalesce(n.kind, 'Unknown') AS kind,
                n.name AS name,
                n.summary AS summary
         LIMIT $nodeLimit`,
        { nodeLimit },
      ),
      driver.executeQuery(
        `MATCH (a)-[r]->(b)
         WHERE a.id IS NOT NULL AND b.id IS NOT NULL
         RETURN a.id AS sourceId,
                b.id AS targetId,
                type(r) AS predicate,
                r.last_observed_at AS lastObservedAt,
                r.aggregate_confidence AS confidence
         LIMIT $edgeLimit`,
        { edgeLimit },
      ),
    ])

    const totalNodes = Number(countN.records[0]?.get("c") ?? 0)
    const totalEdges = Number(countE.records[0]?.get("c") ?? 0)
    const lastUpdatedAt: string | null = null

    const nodes: KnowledgeGraphNode[] = nodeRows.records.map((rec) => ({
      id: rowString(rec.get("id")) ?? "",
      kind: rowString(rec.get("kind")) ?? "Unknown",
      name: rowString(rec.get("name")),
      summary: rowString(rec.get("summary")),
    }))

    const edges: KnowledgeGraphEdge[] = edgeRows.records.map((rec) => {
      const rawConfidence = rec.get("confidence")
      const confidence =
        typeof rawConfidence === "number"
          ? rawConfidence
          : rawConfidence != null && !Number.isNaN(Number(rawConfidence))
            ? Number(rawConfidence)
            : null
      return {
        sourceId: rowString(rec.get("sourceId")) ?? "",
        targetId: rowString(rec.get("targetId")) ?? "",
        predicate: rowString(rec.get("predicate")) ?? "",
        lastObservedAt: rowIsoString(rec.get("lastObservedAt")),
        confidence,
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
