import {
  combineWorkspaceSignals,
  decayWorkspaceSignal,
} from "./claim-confidence.js"
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

export function workspaceGraphNodes(
  units: readonly HydrateUnit[],
): WorkspaceGraphPayload["nodes"] {
  return units.map((unit) => ({
    id: unit.servingId,
    kind: "KnowledgeUnit",
    name: unitName(unit.path),
    summary: unitSummary(unit.body),
  }))
}

export type WorkspaceGraphSignal = Pick<
  ReturnType<typeof hydrateUnitsToProjectionClaims>[number],
  | "subjectId"
  | "objectId"
  | "predicate"
  | "aggregatedConfidence"
  | "validFrom"
  | "validTo"
  | "source"
  | "lastObservedAt"
>

/** Confidence is calculated at read time from raw derived signals. */
export function workspaceGraphFromSignals(input: {
  nodes: WorkspaceGraphPayload["nodes"]
  claims: WorkspaceGraphSignal[]
  lastUpdatedAt?: string | null
  now?: Date
}): WorkspaceGraphPayload {
  const { nodes, claims } = input
  const grouped = new Map<string, number[]>()
  const meta = new Map<
    string,
    {
      sourceId: string
      targetId: string
      predicate: string
      lastObservedAt: string | null
    }
  >()
  for (const claim of claims) {
    const energy = decayWorkspaceSignal({
      confidence: claim.aggregatedConfidence,
      validFrom: claim.validFrom,
      validTo: claim.validTo,
      source: claim.source,
      now: input.now,
    })
    const key = `${claim.subjectId}\0${claim.objectId}\0${claim.predicate}`
    const current = grouped.get(key) ?? []
    current.push(energy)
    grouped.set(key, current)
    if (!meta.has(key)) {
      meta.set(key, {
        sourceId: claim.subjectId,
        targetId: claim.objectId,
        predicate: claim.predicate,
        lastObservedAt: claim.lastObservedAt,
      })
    }
  }
  const edges = [...grouped.entries()].flatMap(([key, energies]) => {
    const confidence = combineWorkspaceSignals(energies)
    const edge = meta.get(key)
    if (!edge || confidence <= 0) return []
    return [{ ...edge, confidence }]
  })
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
