export type KnowledgeGraphPayload = {
  metrics: {
    totalNodes: number
    totalEdges: number
    lastUpdatedAt: string | null
    nodesReturned: number
    edgesReturned: number
    truncated: boolean
  }
  nodes: Array<{
    id: string
    kind: string
    name: string | null
    summary: string | null
    /** Workspace file the node came from. */
    path?: string
  }>
  edges: Array<{
    sourceId: string
    targetId: string
    predicate: string
    lastObservedAt: string | null
    confidence: number | null
  }>
}

export type KnowledgeGraphNode = KnowledgeGraphPayload["nodes"][number]

/** One side of an edge as seen from a specific node's perspective. */
export type NodeClaim = {
  predicate: string
  neighborId: string
  direction: "in" | "out"
  confidence: number | null
  observedAt: number | null
}

export type NodeFactsSummary = {
  inDegree: number
  outDegree: number
  predicateCounts: Map<string, number>
  firstObserved: number | null
  lastObserved: number | null
  neighborKindCounts: Map<string, number>
}

export type NodeFacts = NodeFactsSummary & {
  claims: NodeClaim[]
}
