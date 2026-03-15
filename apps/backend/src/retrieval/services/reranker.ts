import type { Candidate } from "../schema/candidate.js"

/**
 * Reranker interface for precision-focused ranking after candidate generation.
 * A dedicated cross-encoder or external reranker can implement this.
 */
export type Reranker = {
  rerank(query: string, candidates: Candidate[]): Promise<Candidate[]>
}

/** Boost for each additional source channel (corroboration). */
const CORROBORATION_BOOST = 0.15

/**
 * Heuristic reranker: favors candidates that appear in multiple channels.
 * Retrieval for recall; reranking for precision. Replace with cross-encoder
 * or external reranker (e.g. Cohere Rerank) for production.
 */
export const corroborationReranker: Reranker = {
  async rerank(_query, candidates) {
    return [...candidates]
      .map((c) => ({
        ...c,
        score:
          (c.score ?? 0) +
          (c.sourceChannels.length > 1
            ? CORROBORATION_BOOST * (c.sourceChannels.length - 1)
            : 0),
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  },
}

/**
 * Pass-through reranker: returns candidates unchanged.
 * Use corroborationReranker or a cross-encoder for production.
 */
export const passThroughReranker: Reranker = {
  async rerank(_query, candidates) {
    return candidates
  },
}
