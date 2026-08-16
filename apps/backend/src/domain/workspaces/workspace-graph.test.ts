import { describe, expect, it } from "vitest"
import { servingIdForKnowledgePath } from "./hydrate.js"
import { workspaceGraphFromUnits } from "./workspace-graph.js"

describe("workspace graph", () => {
  it("builds this Workspace’s projection from hydrate units", () => {
    const api = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const ledger = servingIdForKnowledgePath(
      "ws_1",
      "knowledge/billing/ledger.md",
    )
    const graph = workspaceGraphFromUnits({
      units: [
        {
          path: "knowledge/payments/api.md",
          servingId: api,
          body: "Payments API talks to the ledger.",
          links: ["../billing/ledger.md"],
          claims: [
            {
              to: "../billing/ledger.md",
              predicate: "DEPENDS_ON",
              confidence: 0.8,
              validFrom: "2026-01-01T00:00:00.000Z",
              validTo: null,
              source: "git",
            },
          ],
        },
        {
          path: "knowledge/billing/ledger.md",
          servingId: ledger,
          body: "Ledger",
          links: [],
          claims: [],
        },
      ],
      lastUpdatedAt: "2026-08-16T10:00:00.000Z",
    })
    expect(graph.metrics).toEqual({
      totalNodes: 2,
      totalEdges: 1,
      lastUpdatedAt: "2026-08-16T10:00:00.000Z",
      nodesReturned: 2,
      edgesReturned: 1,
      truncated: false,
    })
    expect(graph.nodes).toEqual([
      {
        id: api,
        kind: "KnowledgeUnit",
        name: "api",
        summary: "Payments API talks to the ledger.",
      },
      {
        id: ledger,
        kind: "KnowledgeUnit",
        name: "ledger",
        summary: "Ledger",
      },
    ])
    expect(graph.edges).toEqual([
      {
        sourceId: api,
        targetId: ledger,
        predicate: "DEPENDS_ON",
        lastObservedAt: "2026-01-01T00:00:00.000Z",
        confidence: 0.8,
      },
    ])
  })

  it("returns an empty projection when hydrate has no units", () => {
    expect(workspaceGraphFromUnits({ units: [] })).toEqual({
      metrics: {
        totalNodes: 0,
        totalEdges: 0,
        lastUpdatedAt: null,
        nodesReturned: 0,
        edgesReturned: 0,
        truncated: false,
      },
      nodes: [],
      edges: [],
    })
  })
})
