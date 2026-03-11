import type { Candidate } from "../schema/candidate.js"
import type { SourceChannel } from "../schema/candidate.js"

/** Corroboration boost when same entity appears in multiple sources */
const CORROBORATION_BOOST = 0.1

function mergeCandidate(
  existing: Candidate,
  incoming: Candidate,
): Candidate {
  const sourceChannels = [
    ...new Set([...existing.sourceChannels, ...incoming.sourceChannels]),
  ] as SourceChannel[]
  const baseScore = existing.score ?? incoming.score ?? 0
  const score =
    sourceChannels.length > 1 ? baseScore + CORROBORATION_BOOST : baseScore

  return {
    id: existing.id,
    sourceChannels,
    objectId: existing.objectId ?? incoming.objectId,
    claimId: existing.claimId ?? incoming.claimId,
    score,
    payload: { ...existing.payload, ...incoming.payload },
    provenance: existing.provenance ?? incoming.provenance,
  }
}

/** Code candidate input: repo-level (objectId=repositoryId) or file-level (objectId=file:repo:path). */
type CodeCandidateInput = {
  objectId?: string
  repositoryId: string
  repositoryName?: string
  path?: string
  query?: string
  response?: unknown
  score?: number
}

/**
 * Converts raw retrieval results into candidates and merges by objectId.
 * When the same entity appears in multiple sources (e.g. graph + semantic),
 * aggregates sourceChannels and boosts score for corroboration.
 */
export function mergeCandidates(
  semantic: Array<{ objectId: string; kind?: string; payload?: Record<string, unknown>; score?: number }>,
  code: CodeCandidateInput[],
  graph: Array<{ id: string; [key: string]: unknown }>,
  traversal: Array<{ nodeIds: string[]; edgeClaimIds: string[] }>,
): Candidate[] {
  const byId = new Map<string, Candidate>()

  for (const r of semantic) {
    if (!r.objectId) continue
    const id = `cand_sem_${r.objectId}`
    const candidate: Candidate = {
      id,
      sourceChannels: ["semantic"],
      objectId: r.objectId,
      score: r.score,
      payload: { kind: r.kind ?? "unknown", ...r.payload },
    }
    const existing = byId.get(r.objectId)
    byId.set(r.objectId, existing ? mergeCandidate(existing, candidate) : candidate)
  }

  for (const r of code) {
    const objectId = r.objectId ?? r.repositoryId
    if (!objectId) continue
    const id = `cand_code_${objectId}`
    const candidate: Candidate = {
      id,
      sourceChannels: ["code"],
      objectId,
      score: r.score,
      payload: {
        repositoryId: r.repositoryId,
        repositoryName: r.repositoryName,
        path: r.path,
        query: r.query,
        response: r.response,
      },
    }
    const existing = byId.get(objectId)
    byId.set(objectId, existing ? mergeCandidate(existing, candidate) : candidate)
  }

  for (const n of graph) {
    const objectId = n.id
    if (!objectId) continue
    const id = `cand_graph_${objectId}`
    const candidate: Candidate = {
      id,
      sourceChannels: ["graph"],
      objectId,
      payload: n,
    }
    const existing = byId.get(objectId)
    byId.set(objectId, existing ? mergeCandidate(existing, candidate) : candidate)
  }

  for (const t of traversal) {
    for (const nodeId of t.nodeIds) {
      if (!nodeId) continue
      const id = `cand_trav_${nodeId}`
      const candidate: Candidate = {
        id,
        sourceChannels: ["graph"],
        objectId: nodeId,
        payload: { fromTraversal: true, edgeClaimIds: t.edgeClaimIds },
      }
      const existing = byId.get(nodeId)
      byId.set(nodeId, existing ? mergeCandidate(existing, candidate) : candidate)
    }
  }

  return [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
