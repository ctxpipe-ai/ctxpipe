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
    claimId: string | null
    lastObservedAt: string | null
  }>
}

export type KnowledgeGraphNode = KnowledgeGraphPayload["nodes"][number]

export type NodeFacts = {
  inDegree: number
  outDegree: number
  predicateCounts: Map<string, number>
  claimIds: Set<string>
  firstObserved: number | null
  lastObserved: number | null
  neighbourKindCounts: Map<string, number>
}
