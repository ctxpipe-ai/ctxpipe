import { type HydrateUnit, hydrateUnitsToProjectionClaims } from "./hydrate.js"

export type WorkspaceGraphPayload = {
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

function unitName(path: string): string {
  const base = path.split("/").pop() ?? path
  return base.replace(/\.md$/i, "")
}

function unitSummary(body: string): string | null {
  const line = body
    .split("\n")
    .map((row) => row.trim())
    .find(Boolean)
  if (!line) return null
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

export function workspaceGraphFromUnits(input: {
  units: readonly HydrateUnit[]
  lastUpdatedAt?: string | null
}): WorkspaceGraphPayload {
  const claims = hydrateUnitsToProjectionClaims(input.units)
  const nodes = input.units.map((unit) => ({
    id: unit.servingId,
    kind: "KnowledgeUnit",
    name: unitName(unit.path),
    summary: unitSummary(unit.body),
  }))
  const edges = claims.map((claim) => ({
    sourceId: claim.subjectId,
    targetId: claim.objectId,
    predicate: claim.predicate,
    lastObservedAt: claim.lastObservedAt,
    confidence: claim.aggregatedConfidence,
  }))
  return {
    metrics: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      lastUpdatedAt: input.lastUpdatedAt ?? null,
      nodesReturned: nodes.length,
      edgesReturned: edges.length,
      truncated: false,
    },
    nodes,
    edges,
  }
}
