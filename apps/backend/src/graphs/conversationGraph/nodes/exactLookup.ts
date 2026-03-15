import { graphLookup } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

export async function exactLookupNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, plan } = state
  if (!orgId || !orgSlug) return {}
  const step = plan?.steps.find((s) => s.type === "exact_lookup")
  if (!step) return {}

  const params = (step.params ?? {}) as Record<string, unknown>
  const nodeId = params.nodeId as string
  if (!nodeId) return {}

  const node = await graphLookup(orgId, orgSlug, nodeId)
  if (!node) return {}

  return {
    graphNodes: [...state.graphNodes, node],
  }
}
