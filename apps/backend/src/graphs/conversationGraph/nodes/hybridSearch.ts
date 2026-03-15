import { hybridSearch } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

export async function hybridSearchNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, query, embedding, plan } = state
  if (!orgId || !orgSlug) return {}
  const hasStep = plan?.steps.some((s) => s.type === "hybrid_search")
  if (!hasStep || !embedding) return {}

  const resultLimit = plan?.resultLimit ?? 20
  const results = await hybridSearch(
    orgId,
    { embedding, query: query ?? "" },
    { limit: resultLimit },
  )

  const objectIds = [...new Set(state.objectIds), ...results.map((r) => r.objectId)]

  return {
    hybridResults: [...state.hybridResults, ...results],
    objectIds,
  }
}
