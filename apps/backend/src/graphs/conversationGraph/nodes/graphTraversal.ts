import { graphTraversal } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

export async function graphTraversalNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, plan, hybridResults } = state
  if (!orgId || !orgSlug) return {}
  const step = plan?.steps.find((s) => s.type === "graph_traversal")
  if (!step) return {}

  const params = (step.params ?? {}) as Record<string, unknown>
  let startId: string | undefined =
    (params.startId as string) ?? (params.nodeId as string)
  if (!startId && params.anchorFrom === "hybrid" && hybridResults?.length) {
    const first = hybridResults[0] as { objectId?: string }
    startId = first?.objectId
  }
  if (!startId) return {}

  const depthLimit = plan?.depthLimit ?? 3
  const resultLimit = plan?.resultLimit ?? 20
  const maxDepth = (params.maxDepth as number | undefined) ?? depthLimit

  const result = await graphTraversal(orgId, orgSlug, startId as string, {
    maxDepth,
    limit: resultLimit,
  })

  const objectIds = [...new Set(state.objectIds), ...result.nodeIds]
  const claimIds = [...new Set(state.claimIds), ...result.edgeClaimIds]

  return {
    traversalResults: [...state.traversalResults, result],
    objectIds,
    claimIds,
  }
}
