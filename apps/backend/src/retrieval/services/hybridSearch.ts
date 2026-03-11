import { bm25Search } from "./bm25Search.js"
import { vectorSearch } from "./vectorSearch.js"

export type HybridSearchResult = {
  objectId: string
  kind: string
  payload: Record<string, unknown>
  /** Combined RRF score (higher = better) */
  score: number
}

const RRF_K = 60

/**
 * Reciprocal Rank Fusion (RRF) to merge two ranked lists.
 * score = sum(1 / (k + rank)) for each occurrence of objectId
 */
function rrfMerge(
  vectorResults: {
    objectId: string
    kind: string
    payload: Record<string, unknown>
  }[],
  bm25Results: {
    objectId: string
    kind: string
    payload: Record<string, unknown>
  }[],
): HybridSearchResult[] {
  const scores = new Map<
    string,
    { kind: string; payload: Record<string, unknown>; score: number }
  >()

  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i]
    if (!r) continue
    const existing = scores.get(r.objectId)
    const contrib = 1 / (RRF_K + i + 1)
    scores.set(r.objectId, {
      kind: r.kind,
      payload: r.payload,
      score: (existing?.score ?? 0) + contrib,
    })
  }

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i]
    if (!r) continue
    const existing = scores.get(r.objectId)
    const contrib = 1 / (RRF_K + i + 1)
    scores.set(r.objectId, {
      kind: r.kind,
      payload: r.payload,
      score: (existing?.score ?? 0) + contrib,
    })
  }

  return [...scores.entries()]
    .map(([objectId, { kind, payload, score }]) => ({
      objectId,
      kind,
      payload,
      score,
    }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Hybrid search combining vector similarity and BM25 full-text.
 * Uses RRF for score fusion.
 */
export async function hybridSearch(
  orgId: string,
  params: {
    embedding: number[]
    query: string
  },
  options?: { limit?: number },
): Promise<HybridSearchResult[]> {
  const limit = options?.limit ?? 20

  const [vectorResults, bm25Results] = await Promise.all([
    vectorSearch(orgId, params.embedding, { limit: limit * 2 }),
    bm25Search(orgId, params.query, { limit: limit * 2 }),
  ])

  const merged = rrfMerge(vectorResults, bm25Results)
  return merged.slice(0, limit)
}
