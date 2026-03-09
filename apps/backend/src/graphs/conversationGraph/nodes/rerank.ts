import { corroborationReranker } from "../../../retrieval/services/reranker.js"
import type { ConversationGraphState } from "../state.js"

/**
 * Reranks combined candidates. Uses corroboration reranker (favors multi-channel
 * candidates). Replace with cross-encoder or external reranker for production.
 */
export async function rerankNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { query, candidates } = state
  if (!candidates?.length) return {}

  const reranked = await corroborationReranker.rerank(query ?? "", candidates)
  return { candidates: reranked }
}
