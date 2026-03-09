import type { CodeSearchResult } from "../../../retrieval/index.js"
import {
  mergeCandidates,
  parseCodeSearchResults,
} from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

/**
 * Converts retrieval results from all channels (graph, semantic, code) into
 * a unified Candidate[] model. Merges by objectId, aggregates sourceChannels,
 * and boosts score when the same entity appears in multiple sources.
 * Claim hydration happens in assemble (after rerank) for top candidates only.
 */
export async function normalizeNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, claimIds, hybridResults, codeResults, graphNodes, traversalResults } =
    state
  if (!orgId) return {}

  const parsedCode = parseCodeSearchResults((codeResults ?? []) as CodeSearchResult[])
  const candidates = mergeCandidates(
    (hybridResults ?? []).map((r) => ({
      objectId: (r as { objectId?: string }).objectId ?? "",
      type: (r as { type?: string }).type,
      payload: (r as { payload?: Record<string, unknown> }).payload ?? {},
      score: (r as { score?: number }).score,
    })),
    parsedCode,
    (graphNodes ?? []).map((n) => ({
      id: (n as { id?: string }).id ?? "",
      ...n,
    })),
    (traversalResults ?? []).map((t) => ({
      nodeIds: (t as { nodeIds?: string[] }).nodeIds ?? [],
      edgeClaimIds: (t as { edgeClaimIds?: string[] }).edgeClaimIds ?? [],
    })),
  )

  const allClaimIds = [...new Set(claimIds)]

  return {
    claimIds: allClaimIds,
    candidates,
  }
}
