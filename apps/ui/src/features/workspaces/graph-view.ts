import type { WorkspaceGraphPayload } from "./types"

export function graphNodeById(
  graph: WorkspaceGraphPayload,
  nodeId: string | null,
): WorkspaceGraphPayload["nodes"][number] | null {
  if (!nodeId) return null
  return graph.nodes.find((node) => node.id === nodeId) ?? null
}

export function graphEdgesForNode(
  graph: WorkspaceGraphPayload,
  nodeId: string | null,
): Array<{
  predicate: string
  neighbourId: string
  neighbourName: string
  direction: "out" | "in"
  confidence: number | null
}> {
  if (!nodeId) return []
  const names = new Map(
    graph.nodes.map((node) => [node.id, node.name ?? node.id]),
  )
  const rows: Array<{
    predicate: string
    neighbourId: string
    neighbourName: string
    direction: "out" | "in"
    confidence: number | null
  }> = []
  for (const edge of graph.edges) {
    if (edge.sourceId === nodeId) {
      rows.push({
        predicate: edge.predicate,
        neighbourId: edge.targetId,
        neighbourName: names.get(edge.targetId) ?? edge.targetId,
        direction: "out",
        confidence: edge.confidence,
      })
    }
    if (edge.targetId === nodeId) {
      rows.push({
        predicate: edge.predicate,
        neighbourId: edge.sourceId,
        neighbourName: names.get(edge.sourceId) ?? edge.sourceId,
        direction: "in",
        confidence: edge.confidence,
      })
    }
  }
  return rows
}
