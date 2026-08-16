import { describe, expect, it } from "vitest"
import { graphEdgesForNode, graphNodeById } from "./graph-view"
import type { WorkspaceGraphPayload } from "./types"

const graph: WorkspaceGraphPayload = {
  metrics: {
    totalNodes: 2,
    totalEdges: 1,
    lastUpdatedAt: "2026-08-16T10:00:00.000Z",
    nodesReturned: 2,
    edgesReturned: 1,
    truncated: false,
  },
  nodes: [
    {
      id: "kn_api",
      kind: "KnowledgeUnit",
      name: "api",
      summary: "Payments API",
    },
    {
      id: "kn_ledger",
      kind: "KnowledgeUnit",
      name: "ledger",
      summary: "Ledger",
    },
  ],
  edges: [
    {
      sourceId: "kn_api",
      targetId: "kn_ledger",
      predicate: "DEPENDS_ON",
      lastObservedAt: "2026-01-01T00:00:00.000Z",
      confidence: 0.8,
    },
  ],
}

describe("workspace graph view", () => {
  it("resolves a selected unit and its claims", () => {
    expect(graphNodeById(graph, "kn_api")?.name).toBe("api")
    expect(graphEdgesForNode(graph, "kn_api")).toEqual([
      {
        predicate: "DEPENDS_ON",
        neighbourId: "kn_ledger",
        neighbourName: "ledger",
        direction: "out",
        confidence: 0.8,
      },
    ])
    expect(graphEdgesForNode(graph, "kn_ledger")[0]?.direction).toBe("in")
  })
})
