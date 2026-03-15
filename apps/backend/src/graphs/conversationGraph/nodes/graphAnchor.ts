import { graphLookup } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

export async function graphAnchorNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, plan, hybridResults } = state
  if (!orgId || !orgSlug) return {}
  const step = plan?.steps.find((s) => s.type === "graph_anchor")
  if (!step) return {}

  const params = (step.params ?? {}) as Record<string, unknown>
  let nodeId = params.nodeId as string | undefined
  if (!nodeId && params.anchorFrom === "hybrid" && hybridResults?.length) {
    const first = hybridResults[0] as { objectId?: string }
    nodeId = first?.objectId
  }
  if (!nodeId) return {}

  const node = await graphLookup(orgId, orgSlug, nodeId)
  if (!node) return {}

  return {
    graphNodes: [...state.graphNodes, node],
  }
}
