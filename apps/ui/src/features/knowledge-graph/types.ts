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

export type KnowledgeGraphReviewPayload = {
  total: number
  confidenceBelow: number
  limit: number
  items: Array<{
    id: string
    predicate: string
    aggregatedConfidence: number
    lastObservedAt: string
    subject: {
      id: string
      kind: string
      name: string | null
      summary: string | null
    }
    object: {
      id: string
      kind: string
      name: string | null
      summary: string | null
    }
    evidence: Array<{
      id: string
      sourceType: string
      sourceId: string
      sourceUrl: string | null
      sourceLink: string
      extractionMethod: string
      confidence: number
      observedAt: string
    }>
  }>
}

/** One side of an edge as seen from a specific node's perspective. */
export type NodeClaim = {
  predicate: string
  neighbourId: string
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
  neighbourKindCounts: Map<string, number>
}

export type NodeFacts = NodeFactsSummary & {
  claims: NodeClaim[]
}
