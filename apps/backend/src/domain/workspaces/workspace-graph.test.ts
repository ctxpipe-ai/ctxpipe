import { describe, expect, it } from "vitest"

import {
  type WorkspaceGraphSignal,
  workspaceGraphFromSignals,
} from "./workspace-graph.js"

function signal(
  subjectId: string,
  objectId: string,
  predicate: string,
): WorkspaceGraphSignal {
  return {
    subjectId,
    objectId,
    predicate,
    aggregatedConfidence: 1,
    validFrom: null,
    validTo: null,
    source: "git",
    lastObservedAt: "2026-10-01T00:00:00.000Z",
  }
}

describe("workspaceGraphFromSignals", () => {
  it("keeps at most 20 FROM_SOURCE edges of each source and keeps the other edges", () => {
    const units = Array.from({ length: 30 }, (_, index) => `u${index}`)
    const claims = [
      ...units.map((unit) => signal(unit, "shop", "FROM_SOURCE")),
      ...units.slice(0, 3).map((unit) => signal(unit, "eng", "FROM_SOURCE")),
      ...units.map((unit) => signal(unit, "u0", "LINKS_TO")),
    ]
    const graph = workspaceGraphFromSignals({ nodes: [], claims })
    const count = (predicate: string, targetId: string) =>
      graph.edges.filter(
        (edge) => edge.predicate === predicate && edge.targetId === targetId,
      ).length
    expect(count("FROM_SOURCE", "shop")).toBe(20)
    expect(count("FROM_SOURCE", "eng")).toBe(3)
    expect(count("LINKS_TO", "u0")).toBe(30)
    expect(graph.metrics).toMatchObject({
      totalEdges: 63,
      edgesReturned: 53,
      truncated: true,
    })
  })

  it("is not truncated when no source has more than 20 edges", () => {
    const graph = workspaceGraphFromSignals({
      nodes: [],
      claims: [signal("u1", "shop", "FROM_SOURCE")],
    })
    expect(graph.metrics).toMatchObject({
      totalEdges: 1,
      edgesReturned: 1,
      truncated: false,
    })
  })
})
